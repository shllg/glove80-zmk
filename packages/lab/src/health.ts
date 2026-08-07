import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readControlFile, readControlState } from "./control";

interface UpdatedAtRow {
  updated_at: number;
}

export type ServiceState = "active" | "inactive" | "failed" | "activating" | "unknown";

export function systemdServiceState(): ServiceState {
  try {
    const result = Bun.spawnSync([
      "systemctl", "is-active", "keylab.service",
    ], { stdout: "pipe", stderr: "ignore" });
    const value = result.stdout.toString().trim();
    return value === "active" || value === "inactive" || value === "failed" || value === "activating"
      ? value
      : "unknown";
  } catch {
    return "unknown";
  }
}

export interface LabHealth {
  service: ServiceState;
  capture: "fresh" | "stale" | "absent" | "incompatible";
  database: { compatible: boolean; error: string | null };
  snapshotUpdatedAt: number | null;
  snapshotAgeSeconds: number | null;
  hardPaused: boolean;
  softPaused: boolean;
  paused: boolean;
  profile: string;
  profiles: string[];
  profileLease: ReturnType<typeof readControlState>["profile_lease"] | null;
  layer: string | null;
  keystrokesPerMinute: number;
}

export function buildHealth(options: {
  database: Database | null;
  databaseError: string | null;
  profiles: readonly string[];
  controlPath: string;
  pausePath: string;
  nowTs: number;
  service: ServiceState;
  staleAfterSeconds?: number;
}): LabHealth {
  const control = readControlState(options.database, options.profiles);
  const controlFile = readControlFile(options.controlPath);
  const row = options.database?.query("SELECT updated_at FROM live_snapshot WHERE id = 1").get() as
    | UpdatedAtRow
    | null
    | undefined;
  const updatedAt = row ? Number(row.updated_at) : null;
  const age = updatedAt === null ? null : Math.max(0, options.nowTs - updatedAt);
  const compatible = options.database !== null;
  const capture = compatible
    ? updatedAt === null
      ? "absent"
      : age !== null && age <= (options.staleAfterSeconds ?? 5) ? "fresh" : "stale"
    : options.databaseError?.includes("schema_version") ? "incompatible" : "absent";
  const hardPaused = existsSync(options.pausePath);
  const softPaused = controlFile?.paused ?? (control.paused && !hardPaused);
  return {
    service: options.service,
    capture,
    database: { compatible, error: options.databaseError },
    snapshotUpdatedAt: updatedAt,
    snapshotAgeSeconds: age,
    hardPaused,
    softPaused,
    paused: hardPaused || softPaused,
    profile: control.profile,
    profiles: control.profiles,
    profileLease: control.profile_lease ?? null,
    layer: control.layer,
    keystrokesPerMinute: control.keystrokes_per_minute,
  };
}
