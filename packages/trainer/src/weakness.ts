import type { Database } from "bun:sqlite";
import type { AnalysisMeta } from "@glove80/analysis/meta";
import type { AnalysisMetrics } from "@glove80/analysis/metrics";

/**
 * Three sources, three genuinely different weaknesses:
 *
 * | source          | measures                                              | sharpness       |
 * |-----------------|-------------------------------------------------------|-----------------|
 * | trainer history | per-position error rate, substitutions, digraph latency | ground truth, best |
 * | keylab Tier B   | position frequency                                    | frequency is not weakness; only useful combined |
 * | keylab Tier A   | finger imbalance, hold outliers, correction runs, mod misfires | real-use friction |
 *
 * Day one there is no trainer history, so the model bootstraps off keylab and switches to
 * trainer-derived scoring as sessions accumulate. `confidence` reports which regime produced a
 * given entry so a drill built on frequency alone is never mistaken for one built on error data.
 */

export type WeaknessSource = "trainer" | "keylab-tier-a" | "keylab-tier-b";

export interface PositionWeakness {
  pos: number;
  label: string;
  finger: string;
  /** 0..1, higher is worse. */
  score: number;
  errorRate: number | null;
  attempts: number;
  presses: number;
  sources: WeaknessSource[];
}

export interface BigramWeakness {
  from: string;
  to: string;
  label: string;
  /** Median inter-key latency in milliseconds across observed occurrences. */
  medianLatencyMs: number;
  occurrences: number;
  sameFinger: boolean;
}

export interface MechanicWeakness {
  kind: string;
  label: string;
  detail: string;
  /** 0..1, higher is worse. */
  score: number;
}

export interface WeaknessModel {
  confidence: "bootstrap" | "trainer";
  sessionCount: number;
  positions: PositionWeakness[];
  bigrams: BigramWeakness[];
  mechanics: MechanicWeakness[];
}

interface ExpectedRow {
  expected_code: string;
  attempts: number;
  errors: number;
}

interface LatencyRow {
  from_code: string;
  to_code: string;
  latency: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * `KeyboardEvent.code` values map onto keymap positions through the base keycode the generator
 * already emits, so the trainer and keylab agree on what "position 35" means without the trainer
 * having to know anything about the firmware.
 */
export function browserCodeToKeyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return `KEY_${code.slice(3)}`;
  if (/^Digit[0-9]$/.test(code)) return `KEY_${code.slice(5)}`;
  const named: Record<string, string> = {
    Space: "KEY_SPACE", Enter: "KEY_ENTER", Backspace: "KEY_BACKSPACE", Tab: "KEY_TAB",
    Minus: "KEY_MINUS", Equal: "KEY_EQUAL", BracketLeft: "KEY_LEFTBRACE",
    BracketRight: "KEY_RIGHTBRACE", Backslash: "KEY_BACKSLASH", Semicolon: "KEY_SEMICOLON",
    Quote: "KEY_APOSTROPHE", Backquote: "KEY_GRAVE", Comma: "KEY_COMMA", Period: "KEY_DOT",
    Slash: "KEY_SLASH", IntlBackslash: "KEY_102ND",
  };
  return named[code] ?? null;
}

function positionsByKeyName(meta: AnalysisMeta): Map<string, { pos: number; finger: string }> {
  const byName = new Map<string, { pos: number; finger: string }>();
  for (const position of meta.positions) {
    if (position.baseKeycode && !byName.has(position.baseKeycode)) {
      byName.set(position.baseKeycode, { pos: position.pos, finger: position.finger });
    }
  }
  return byName;
}

/** Real-use friction from Tier A. None of this is visible to any word-list drill. */
function mechanicsFromTierA(metrics: AnalysisMetrics): MechanicWeakness[] {
  const mechanics: MechanicWeakness[] = [];

  // The measured R_GUI hold — median ~750 ms against 160-240 ms for every other modifier — is the
  // canonical example: not an accuracy problem, and no word list will ever surface it.
  const holds = metrics.modifierHolds.filter((modifier) => modifier.count > 0);
  const baseline = median(holds.map((modifier) => modifier.median.ms));
  for (const modifier of holds) {
    if (baseline > 0 && modifier.median.ms > baseline * 2) {
      mechanics.push({
        kind: "hold-outlier",
        label: `${modifier.label} hold`,
        detail: `median ${modifier.median.label} against a ${baseline} ms baseline`
          + ` (p95 ${modifier.p95.label}, n=${modifier.count})`,
        score: clamp01(modifier.median.ms / (baseline * 4)),
      });
    }
  }

  for (const kind of metrics.misfires.kinds) {
    if (kind.count === 0) continue;
    const worst = [...kind.byModClass].sort((left, right) => right.per1000 - left.per1000)[0];
    mechanics.push({
      kind: kind.label.toLowerCase().replaceAll("_", "-"),
      label: kind.label,
      detail: `${kind.per1000.toFixed(2)} per 1000 keystrokes`
        + (worst && worst.count > 0 ? `, worst on ${worst.label}` : ""),
      // 5 per 1000 is the design's headline target for LONELY_MOD; use it as the full-scale mark.
      score: clamp01(kind.per1000 / 5),
    });
  }

  const fingers = metrics.perFinger.filter((finger) => finger.presses > 0);
  const evenShare = fingers.length > 0 ? 1 / fingers.length : 0;
  for (const finger of fingers) {
    if (evenShare > 0 && finger.share > evenShare * 2) {
      mechanics.push({
        kind: "finger-imbalance",
        label: `${finger.label} overload`,
        detail: `${(finger.share * 100).toFixed(1)}% of attributed presses`
          + ` against an even ${(evenShare * 100).toFixed(1)}%`,
        score: clamp01((finger.share - evenShare) / (1 - evenShare)),
      });
    }
  }

  if (metrics.correctionTax.positionalShare > 0.05) {
    mechanics.push({
      kind: "correction-run",
      label: "Correction tax",
      detail: `${(metrics.correctionTax.positionalShare * 100).toFixed(1)}% of Tier B keystrokes`
        + " are backspaces",
      score: clamp01(metrics.correctionTax.positionalShare / 0.2),
    });
  }

  return mechanics.sort((left, right) => right.score - left.score);
}

export interface WeaknessOptions {
  /** Ignore positions with fewer attempts than this; below it an error rate is noise. */
  minimumAttempts?: number;
  limit?: number;
}

export function buildWeaknessModel(
  trainer: Database,
  meta: AnalysisMeta,
  metrics: AnalysisMetrics,
  options: WeaknessOptions = {},
): WeaknessModel {
  const minimumAttempts = options.minimumAttempts ?? 20;
  const limit = options.limit ?? 12;
  const byName = positionsByKeyName(meta);

  const sessionCount = Number(
    (trainer.query("SELECT COUNT(*) AS n FROM session WHERE ended_ts IS NOT NULL")
      .get() as { n: number }).n,
  );

  const expected = trainer.query(`
    SELECT expected_code, COUNT(*) AS attempts, SUM(1 - correct) AS errors
    FROM keystroke WHERE expected_code IS NOT NULL
    GROUP BY expected_code
  `).all() as ExpectedRow[];
  const trainerByName = new Map(expected.map((row) => [row.expected_code, row]));
  const usableTrainerData = expected.some((row) => Number(row.attempts) >= minimumAttempts);

  // Tier B frequency. On its own frequency is not weakness — a key you press often is not a key you
  // press badly — so it only ever breaks ties and only ever contributes a minority of the score.
  const maximumPresses = Math.max(1, ...metrics.positionLoad.map((position) => position.presses));

  const positions: PositionWeakness[] = metrics.positionLoad
    .filter((position) => position.baseKeycode !== null)
    .map((position) => {
      const row = position.baseKeycode ? trainerByName.get(position.baseKeycode) : undefined;
      const attempts = row ? Number(row.attempts) : 0;
      const errorRate = row && attempts >= minimumAttempts
        ? Number(row.errors) / attempts
        : null;
      const frequency = position.presses / maximumPresses;
      const sources: WeaknessSource[] = [];
      if (errorRate !== null) sources.push("trainer");
      if (position.presses > 0) sources.push("keylab-tier-b");
      const score = errorRate !== null
        ? clamp01(errorRate * 0.8 + frequency * 0.2)
        : clamp01(frequency * 0.4);
      return {
        pos: position.pos,
        label: position.baseKeycode?.replace(/^KEY_/, "") ?? String(position.pos),
        finger: position.finger,
        score,
        errorRate,
        attempts,
        presses: position.presses,
        sources,
      };
    })
    .filter((position) => position.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const latencies = trainer.query(`
    SELECT previous.code AS from_code, current.code AS to_code,
           current.ts_ms - previous.ts_ms AS latency
    FROM keystroke current
    JOIN keystroke previous
      ON previous.session_id = current.session_id AND previous.seq = current.seq - 1
    WHERE current.correct = 1 AND previous.correct = 1
      AND current.ts_ms > previous.ts_ms AND current.ts_ms - previous.ts_ms < 2000
  `).all() as LatencyRow[];
  const grouped = new Map<string, number[]>();
  for (const row of latencies) {
    const key = `${row.from_code} ${row.to_code}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(Number(row.latency));
    grouped.set(key, bucket);
  }
  const bigrams: BigramWeakness[] = [...grouped.entries()]
    .map(([key, values]) => {
      const [from = "", to = ""] = key.split(" ");
      const fromName = browserCodeToKeyName(from);
      const toName = browserCodeToKeyName(to);
      const fromFinger = fromName ? byName.get(fromName)?.finger : undefined;
      const toFinger = toName ? byName.get(toName)?.finger : undefined;
      return {
        from,
        to,
        label: `${from} → ${to}`,
        medianLatencyMs: median(values),
        occurrences: values.length,
        sameFinger: fromFinger !== undefined && fromFinger === toFinger,
      };
    })
    .filter((bigram) => bigram.occurrences >= 3)
    .sort((left, right) => right.medianLatencyMs - left.medianLatencyMs)
    .slice(0, limit);

  return {
    confidence: usableTrainerData ? "trainer" : "bootstrap",
    sessionCount,
    positions,
    bigrams,
    mechanics: mechanicsFromTierA(metrics),
  };
}
