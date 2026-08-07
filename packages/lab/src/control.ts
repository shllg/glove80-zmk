import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface ProfileLease {
  id: string;
  restore_profile: string;
  expires_at: number;
}

export interface ControlFileState {
  paused: boolean;
  profile: string;
  profile_lease?: ProfileLease;
}

export interface ControlState extends ControlFileState {
  profiles: string[];
  layer: string | null;
  keystrokes_per_minute: number;
  profile_lease?: ProfileLease;
}

interface SnapshotRow {
  json: string;
}

export function readControlState(
  database: Database | null,
  fallbackProfiles: readonly string[],
): ControlState {
  let snapshot: Record<string, unknown> = {};
  if (database !== null) {
    const row = database.query("SELECT json FROM live_snapshot WHERE id = 1").get() as
      | SnapshotRow
      | null;
    snapshot = row ? JSON.parse(row.json) as Record<string, unknown> : {};
  }
  const profiles = Array.isArray(snapshot.profiles)
    && snapshot.profiles.length > 0
    && snapshot.profiles.every((profile) => typeof profile === "string")
    ? snapshot.profiles as string[]
    : [...fallbackProfiles];
  const lease = snapshot.profile_lease;
  return {
    paused: snapshot.paused === true,
    profile: typeof snapshot.profile === "string" ? snapshot.profile : (profiles[0] ?? "default"),
    profiles,
    layer: typeof snapshot.layer === "string" ? snapshot.layer : null,
    keystrokes_per_minute: typeof snapshot.keystrokes_per_minute === "number"
      ? snapshot.keystrokes_per_minute
      : 0,
    ...(validLease(lease) ? { profile_lease: lease } : {}),
  };
}

function validLease(value: unknown): value is ProfileLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  return typeof lease.id === "string"
    && typeof lease.restore_profile === "string"
    && Number.isInteger(lease.expires_at);
}

const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 2;
const CORRUPT_LOCK_STALE_MS = 5_000;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

function lockIsStale(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
      return !existsSync(`/proc/${Number(owner.pid)}`);
    }
  } catch {
    // A process may have died between create and writing its owner record. Give a live writer a
    // short grace period, then make that otherwise-permanent crash residue recoverable.
  }
  try {
    return Date.now() - statSync(path).mtimeMs > CORRUPT_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function withControlLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  let handle: number | null = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const candidate = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(candidate, JSON.stringify({ pid: process.pid }));
        fsyncSync(candidate);
      } catch (error) {
        closeSync(candidate);
        try { unlinkSync(lockPath); } catch { /* The failed owner record is not a lock. */ }
        throw error;
      }
      handle = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockIsStale(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* Another contender recovered it first. */ }
        continue;
      }
      Atomics.wait(lockSleep, 0, 0, LOCK_RETRY_MS);
    }
  }
  if (handle === null) throw new Error("The keylab control file is busy; retry the operation");
  try {
    return operation();
  } finally {
    closeSync(handle);
    try { unlinkSync(lockPath); } catch { /* A completed write must not be undone by cleanup. */ }
  }
}

function writeControlFileUnlocked(path: string, state: ControlFileState, nowTs: number): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify({ ...state, updated_at: nowTs }, null, 2)}\n`;
  let handle: number | null = null;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeSync(handle, payload);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(temporary, path);
  } finally {
    if (handle !== null) closeSync(handle);
    try { unlinkSync(temporary); } catch { /* rename removed it, or cleanup is best effort. */ }
  }
}

/** Serializes every read/modify/write and installs a uniquely named sibling file atomically. */
export function writeControlFile(path: string, state: ControlFileState, nowTs: number): void {
  withControlLock(path, () => writeControlFileUnlocked(path, state, nowTs));
}

export function readControlFile(path: string): ControlFileState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.paused !== "boolean" || typeof parsed.profile !== "string") return null;
    return {
      paused: parsed.paused,
      profile: parsed.profile,
      ...(validLease(parsed.profile_lease) ? { profile_lease: parsed.profile_lease } : {}),
    };
  } catch {
    return null;
  }
}

/** Manual profile changes own the profile and therefore clear any training lease. */
export function updateManualControl(
  path: string,
  fallback: ControlFileState,
  update: { paused?: boolean; profile?: string },
  nowTs: number,
): void {
  withControlLock(path, () => {
    const current = readControlFile(path) ?? fallback;
    writeControlFileUnlocked(path, {
      paused: update.paused ?? current.paused,
      profile: update.profile ?? current.profile,
      ...(update.profile === undefined && current.profile_lease
        ? { profile_lease: current.profile_lease }
        : {}),
    }, nowTs);
  });
}

export type LeaseAcquisition =
  | { status: "acquired"; restoreProfile: string }
  | { status: "busy" }
  | { status: "paused" };

/**
 * Acquires against the current control file, not the eventually-consistent live snapshot. The
 * lock keeps the ownership check and replacement one operation across Lab, keylabctl and daemon
 * writers. An expired lease contributes its restore profile as the effective current profile.
 */
export function acquireProfileLease(
  path: string,
  fallback: ControlFileState,
  desiredProfile: string,
  leaseId: string,
  expiresAt: number,
  nowTs: number,
): LeaseAcquisition {
  return withControlLock(path, () => {
    const current = readControlFile(path) ?? fallback;
    if (current.paused) return { status: "paused" };
    if (current.profile_lease && current.profile_lease.expires_at > nowTs) {
      return { status: "busy" };
    }
    const restoreProfile = current.profile_lease?.restore_profile ?? current.profile;
    writeControlFileUnlocked(path, {
      paused: current.paused,
      profile: desiredProfile,
      profile_lease: {
        id: leaseId,
        restore_profile: restoreProfile,
        expires_at: expiresAt,
      },
    }, nowTs);
    return { status: "acquired", restoreProfile };
  });
}

/** Restore only when the control file still belongs to this lease; external changes always win. */
export function restoreOwnedLease(path: string, leaseId: string, nowTs: number): boolean {
  return withControlLock(path, () => {
    const current = readControlFile(path);
    if (!current?.profile_lease || current.profile_lease.id !== leaseId) return false;
    writeControlFileUnlocked(path, {
      paused: current.paused,
      profile: current.profile_lease.restore_profile,
    }, nowTs);
    return true;
  });
}

/** Renew only the caller's current lease. Returns false after any manual profile override. */
export function renewOwnedLease(
  path: string,
  leaseId: string,
  expiresAt: number,
  nowTs: number,
): boolean {
  return withControlLock(path, () => {
    const current = readControlFile(path);
    if (!current?.profile_lease
      || current.profile_lease.id !== leaseId
      || current.profile_lease.expires_at <= nowTs) return false;
    writeControlFileUnlocked(path, {
      ...current,
      profile_lease: { ...current.profile_lease, expires_at: expiresAt },
    }, nowTs);
    return true;
  });
}
