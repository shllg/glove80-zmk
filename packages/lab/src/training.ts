import { randomUUID } from "node:crypto";
import type { AnalysisMeta } from "../../analysis/src/meta";
import type { AnalysisMetrics } from "../../analysis/src/metrics";
import { attributeCorrections } from "../../trainer/src/corrections";
import { scoreSession } from "../../trainer/src/scoring";
import {
  prepareTrainingSession,
  type PreparedTrainingSession,
  type TrainingRequest,
} from "../../trainer/src/session";
import type {
  CorrectionRecord,
  KeystrokeRecord,
  TrainerStore,
} from "../../trainer/src/store";
import {
  acquireProfileLease,
  renewOwnedLease,
  restoreOwnedLease,
  type ControlState,
} from "./control";

export const PROFILE_LEASE_SECONDS = 60;

export class TrainingRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid-request") {
    super(message);
  }
}

interface ActiveSession {
  token: string;
  prepared: PreparedTrainingSession;
  startedTs: number;
  keylabProfile: string | null;
  leaseId: string | null;
  warning: string | null;
  expiresAt: number;
}

export interface TrainingStartContext {
  meta?: AnalysisMeta;
  metrics?: AnalysisMetrics;
  captureAvailable: boolean;
  control: ControlState;
  allowTrainerOnly?: boolean;
  confirmLease(leaseId: string, profile: string): Promise<boolean>;
}

export interface TrainingManager {
  start(request: TrainingRequest, context: TrainingStartContext): Promise<Record<string, unknown>>;
  heartbeat(token: unknown): Record<string, unknown>;
  finish(body: Record<string, unknown>): Record<string, unknown>;
  cancel(token: unknown): boolean;
  activeCount(): number;
  close(): void;
}

export function parseKeystrokes(value: unknown): KeystrokeRecord[] {
  if (!Array.isArray(value)) throw new TrainingRequestError("keystrokes must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new TrainingRequestError(`keystroke ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.code !== "string"
      || typeof record.tsMs !== "number"
      || !Number.isFinite(record.tsMs)) {
      throw new TrainingRequestError(`keystroke ${index} is missing code or tsMs`);
    }
    return {
      seq: index,
      tsMs: Math.round(record.tsMs),
      code: record.code.slice(0, 100),
      expectedCode: typeof record.expectedCode === "string"
        ? record.expectedCode.slice(0, 100)
        : null,
      correct: record.correct === true,
    };
  });
}

export function parseCorrections(value: unknown): CorrectionRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TrainingRequestError("corrections must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new TrainingRequestError(`correction ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.tsMs !== "number" || !Number.isFinite(record.tsMs)) {
      throw new TrainingRequestError(`correction ${index} is missing tsMs`);
    }
    if (!Number.isInteger(record.charIndex) || Number(record.charIndex) < 0) {
      throw new TrainingRequestError(`correction ${index} has no non-negative integer charIndex`);
    }
    if (!Number.isInteger(record.runLength) || Number(record.runLength) < 1) {
      throw new TrainingRequestError(`correction ${index} has no positive integer runLength`);
    }
    return {
      seq: index,
      tsMs: Math.round(record.tsMs),
      charIndex: Number(record.charIndex),
      runLength: Number(record.runLength),
      expectedCode: typeof record.expectedCode === "string"
        ? record.expectedCode.slice(0, 100)
        : null,
    };
  });
}

function tokenFrom(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TrainingRequestError("token is required");
  }
  return value;
}

function profileFor(language: string): string {
  return language === "de" ? "training-de" : language === "code" ? "training-code" : "training-en";
}

export function createTrainingManager(options: {
  store: TrainerStore;
  controlPath: string;
  now: () => number;
  restoreLease?: typeof restoreOwnedLease;
}): TrainingManager {
  const active = new Map<string, ActiveSession>();
  const restoreLease = options.restoreLease ?? restoreOwnedLease;

  const restore = (session: ActiveSession): string | null => {
    if (session.leaseId === null) return null;
    try {
      restoreLease(options.controlPath, session.leaseId, options.now());
      return null;
    } catch (error) {
      return "The session result is saved, but Lab could not restore the capture profile; "
        + `the daemon lease will expire automatically. (${error instanceof Error ? error.message : String(error)})`;
    }
  };

  const expireAbandoned = () => {
    const timestamp = options.now();
    for (const [token, session] of active) {
      if (session.expiresAt > timestamp) continue;
      active.delete(token);
      restore(session);
    }
  };

  return {
    async start(request, context) {
      expireAbandoned();
      if (active.size > 0) {
        throw new TrainingRequestError(
          "Another training session is already active in Lab",
          409,
          "training-busy",
        );
      }
      let prepared: PreparedTrainingSession;
      if (request.mode === "drill"
        && request.family === "mechanic"
        && (!context.captureAvailable || context.control.paused || context.metrics === undefined)) {
        throw new TrainingRequestError(
          "Mechanic drills require active, unpaused keylab capture",
          409,
          "capture-required",
        );
      }
      try {
        prepared = prepareTrainingSession(options.store, context.meta, context.metrics, request);
      } catch (error) {
        throw new TrainingRequestError(error instanceof Error ? error.message : String(error));
      }
      let keylabProfile: string | null = null;
      let leaseId: string | null = null;
      let warning: string | null = null;

      if (!context.captureAvailable || context.control.paused) {
        if (prepared.drillFamily === "mechanic") {
          throw new TrainingRequestError(
            "Mechanic drills require active, unpaused keylab capture",
            409,
            "capture-required",
          );
        }
        if (context.control.paused && !context.allowTrainerOnly) {
          throw new TrainingRequestError(
            "Keylab is paused. Resume it yourself or choose trainer-only practice.",
            409,
            "capture-paused",
          );
        }
        warning = context.control.paused
          ? "Trainer-only practice: keylab is paused and Lab did not resume it."
          : "Trainer-only practice: keylab capture is unavailable; no telemetry profile is active.";
      } else {
        const desired = profileFor(prepared.language);
        if (!context.control.profiles.includes(desired)) {
          throw new TrainingRequestError(
            `Keylab does not configure the required ${desired} profile`,
            409,
            "profile-unavailable",
          );
        }
        const fallback = {
          paused: false,
          profile: context.control.profile,
        };
        leaseId = randomUUID();
        const acquired = acquireProfileLease(
          options.controlPath,
          fallback,
          desired,
          leaseId,
          options.now() + PROFILE_LEASE_SECONDS,
          options.now(),
        );
        if (acquired.status === "busy") {
          throw new TrainingRequestError(
            "The daemon already has an active training profile lease",
            409,
            "training-busy",
          );
        }
        if (acquired.status === "paused") {
          throw new TrainingRequestError(
            "Keylab was paused while training started. Choose trainer-only practice.",
            409,
            "capture-paused",
          );
        }
        if (!await context.confirmLease(leaseId, desired)) {
          restoreLease(options.controlPath, leaseId, options.now());
          throw new TrainingRequestError(
            `The daemon did not confirm ${desired} within three seconds`,
            409,
            "profile-unconfirmed",
          );
        }
        keylabProfile = desired;
      }

      const token = randomUUID();
      active.set(token, {
        token,
        prepared,
        startedTs: options.now(),
        keylabProfile,
        leaseId,
        warning,
        expiresAt: options.now() + PROFILE_LEASE_SECONDS,
      });
      return {
        token,
        ...prepared,
        keylabProfile,
        captureMode: keylabProfile === null ? "trainer-only" : "keylab",
        warning,
        leaseExpiresAt: leaseId === null ? null : options.now() + PROFILE_LEASE_SECONDS,
      };
    },

    heartbeat(value) {
      const token = tokenFrom(value);
      const session = active.get(token);
      if (!session) throw new TrainingRequestError("Active session not found", 404, "not-found");
      const now = options.now();
      if (session.expiresAt <= now) {
        active.delete(token);
        restore(session);
        throw new TrainingRequestError("Active session expired", 404, "not-found");
      }
      const expiresAt = now + PROFILE_LEASE_SECONDS;
      if (session.leaseId === null) {
        session.expiresAt = expiresAt;
        return { ok: true, leaseExpiresAt: null };
      }
      if (!renewOwnedLease(options.controlPath, session.leaseId, expiresAt, now)) {
        // Once another writer owns the profile, this session can no longer truthfully attribute
        // its result to the profile it started with. Terminate it instead of allowing a save.
        active.delete(token);
        throw new TrainingRequestError(
          "The training profile was changed outside this session; the session ended without saving",
          409,
          "lease-lost",
        );
      }
      session.expiresAt = expiresAt;
      return { ok: true, leaseExpiresAt: expiresAt };
    },

    finish(body) {
      const token = tokenFrom(body.token);
      const session = active.get(token);
      if (!session) throw new TrainingRequestError("Active session not found", 404, "not-found");
      const now = options.now();
      if (session.expiresAt <= now) {
        active.delete(token);
        restore(session);
        throw new TrainingRequestError("Active session expired", 404, "not-found");
      }
      const keystrokes = parseKeystrokes(body.keystrokes);
      const corrections = parseCorrections(body.corrections);
      if (session.prepared.drillFamily !== "mechanic" && keystrokes.length === 0) {
        throw new TrainingRequestError("A completed typing session must contain keystrokes");
      }
      const score = session.prepared.drillFamily === "mechanic" ? null : scoreSession(keystrokes);
      const attribution = attributeCorrections(session.prepared.text, corrections, keystrokes);
      if (session.leaseId !== null) {
        const expiresAt = now + PROFILE_LEASE_SECONDS;
        if (!renewOwnedLease(options.controlPath, session.leaseId, expiresAt, now)) {
          active.delete(token);
          throw new TrainingRequestError(
            "The training profile was changed outside this session; the session ended without saving",
            409,
            "lease-lost",
          );
        }
        // If persistence fails, keep the now-confirmed lease alive for a safe retry.
        session.expiresAt = expiresAt;
      }
      // Validation and scoring happen before this call. If the transaction throws, the active map
      // and lease stay intact so the browser can retry instead of losing the finished result.
      const sessionId = options.store.saveCompletedSession({
        startedTs: session.startedTs,
        endedTs: now,
        mode: session.prepared.mode,
        language: session.prepared.language,
        corpusId: session.prepared.corpusId,
        corpusVersion: session.prepared.corpusVersion,
        seed: session.prepared.seed,
        deviceLabel: session.prepared.deviceLabel,
        keylabProfile: session.keylabProfile,
        text: session.prepared.text,
        drillFamily: session.prepared.drillFamily,
      }, keystrokes, corrections);
      active.delete(token);
      const warning = restore(session);
      return { sessionId, score, corrections: attribution, warning };
    },

    cancel(value) {
      const token = tokenFrom(value);
      const session = active.get(token);
      if (!session) return false;
      active.delete(token);
      restore(session);
      return session.expiresAt > options.now();
    },

    activeCount() {
      expireAbandoned();
      return active.size;
    },

    close() {
      for (const session of active.values()) restore(session);
      active.clear();
    },
  };
}
