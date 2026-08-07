import type { Database } from "bun:sqlite";
import type { AnalysisMeta } from "@glove80/analysis/meta";
import {
  FINGER_ABSENT,
  FINGER_LABELS,
  type AnalysisMetrics,
  type CorrectionContext,
  type LatencyClass,
} from "@glove80/analysis/metrics";

/**
 * Four sources, four genuinely different weaknesses:
 *
 * | source          | measures                                              | sharpness       |
 * |-----------------|-------------------------------------------------------|-----------------|
 * | trainer history | per-position error rate, substitutions, digraph latency | ground truth, best |
 * | keylab Tier C   | which key was corrected in real work, and how quickly | real-use error; no ground truth about intent |
 * | keylab Tier B   | position frequency                                    | frequency is not weakness; only useful combined |
 * | keylab Tier A   | finger imbalance, hold outliers, correction runs, mod misfires | real-use friction |
 *
 * Tier C sits between the two: it is evidence of *error*, which frequency is not, but it never sees
 * the text and so cannot know what the hand meant to type. It is therefore scored above frequency
 * and below trainer history, and it is never folded into either — a new source gets its own label
 * or a drill built on one kind of evidence gets read as though it were built on another.
 *
 * Day one there is no trainer history, so the model bootstraps off keylab and switches to
 * trainer-derived scoring as sessions accumulate. `confidence` reports which regime produced a
 * given entry so a drill built on frequency alone is never mistaken for one built on error data.
 */

export type WeaknessSource = "trainer" | "keylab-tier-a" | "keylab-tier-b" | "keylab-tier-c";

/**
 * Tier C latency weights. A fumble is a mistyped key; a deletion a second or more after the last
 * keystroke is a rewrite, and weighting the two the same would drag the model toward the keys you
 * change your mind about rather than the keys you get wrong. Ambiguous sits between and counts half.
 */
const LATENCY_WEIGHTS: Record<LatencyClass, number> = { fumble: 1, ambiguous: 0.5, edit: 0 };

/** A key deleted after one press in ten is as bad as this model needs to be able to say. */
const CORRECTION_RATE_FULL_SCALE = 0.1;

export interface PositionWeakness {
  pos: number;
  label: string;
  finger: string;
  /** 0..1, higher is worse. */
  score: number;
  errorRate: number | null;
  attempts: number;
  presses: number;
  /** Tier C: every correction that ended on this key, whatever its latency class. */
  corrections: number;
  /**
   * Latency-weighted corrections per press, or `null` when the key has too few presses in range for
   * a rate to mean anything — no data, which is not the same as a clean key.
   */
  correctionRate: number | null;
  sources: WeaknessSource[];
}

/** A transition that preceded corrections, from Tier C's ordered trigrams or their finger rollup. */
export interface TransitionWeakness {
  label: string;
  /** The two base-layer letters when both keys have one; a drill needs text it can render. */
  letters: string | null;
  /** Finger labels instead, when the row degraded and lost its position identity. */
  fingers: [string, string] | null;
  /** Corrections after this transition, every latency class. */
  corrections: number;
  /** The same corrections after latency weighting; this is what the ranking uses. */
  weight: number;
  degraded: boolean;
  sameFinger: boolean;
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
  confidence: "keymap" | "bootstrap" | "keylab-tier-c" | "trainer";
  sessionCount: number;
  positions: PositionWeakness[];
  bigrams: BigramWeakness[];
  correctedTransitions: TransitionWeakness[];
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

function weightedCorrections(byLatency: Record<LatencyClass, number>): number {
  return byLatency.fumble * LATENCY_WEIGHTS.fumble
    + byLatency.ambiguous * LATENCY_WEIGHTS.ambiguous
    + byLatency.edit * LATENCY_WEIGHTS.edit;
}

function keyLabel(keycode: string | null, pos: number): string {
  return keycode?.replace(/^KEY_/, "") ?? String(pos);
}

/**
 * Tier C transitions: the pair immediately before each correction, from the ordered trigrams and
 * from the finger rollup that rare trigrams degrade into.
 *
 * The position rows come from `topNgrams`, which the analysis package truncates to its display
 * limit — the per-key marginal is complete, but a *pair* only exists in the rows themselves. That
 * cap is stated here rather than hidden: it takes the most frequent transitions and misses a long
 * tail of rare ones.
 *
 * A degraded row names two fingers and no positions. It is real evidence about a motion and it is
 * kept, but it is never attributed to a position, because it no longer identifies one.
 */
function correctedTransitions(
  meta: AnalysisMeta,
  context: CorrectionContext,
  limit: number,
): TransitionWeakness[] {
  const byPair = new Map<string, TransitionWeakness>();
  const accumulate = (key: string, entry: TransitionWeakness) => {
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, entry);
      return;
    }
    existing.corrections += entry.corrections;
    existing.weight += entry.weight;
  };

  for (const ngram of context.topNgrams) {
    const [, from, to] = ngram.positions;
    const fromMeta = meta.position(from);
    const toMeta = meta.position(to);
    // A sentinel slot has no position, so it names no transition at all.
    if (!fromMeta || !toMeta) continue;
    const letters = /^KEY_[A-Z]$/.test(fromMeta.baseKeycode ?? "")
      && /^KEY_[A-Z]$/.test(toMeta.baseKeycode ?? "")
      ? `${fromMeta.baseKeycode?.slice(4)}${toMeta.baseKeycode?.slice(4)}`.toLowerCase()
      : null;
    accumulate(`p:${from}:${to}`, {
      label: `${keyLabel(fromMeta.baseKeycode, from)} → ${keyLabel(toMeta.baseKeycode, to)}`,
      letters,
      fingers: null,
      corrections: ngram.count,
      weight: ngram.count * LATENCY_WEIGHTS[ngram.latencyClass],
      degraded: false,
      sameFinger: fromMeta.finger === toMeta.finger,
    });
  }

  for (const entry of context.byFinger) {
    const [, from, to] = entry.fingers;
    if (from === FINGER_ABSENT || to === FINGER_ABSENT) continue;
    const fromLabel = FINGER_LABELS[from];
    const toLabel = FINGER_LABELS[to];
    if (!fromLabel || !toLabel) continue;
    accumulate(`f:${from}:${to}`, {
      label: `${fromLabel} → ${toLabel}`,
      letters: null,
      fingers: [fromLabel, toLabel],
      corrections: entry.count,
      weight: entry.count * LATENCY_WEIGHTS[entry.latencyClass],
      degraded: true,
      sameFinger: from === to,
    });
  }

  return [...byPair.values()]
    // A transition corrected only after a second of thought is a rewrite, not a weakness.
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.label.localeCompare(right.label))
    .slice(0, limit);
}

export interface WeaknessOptions {
  /** Ignore positions with fewer attempts than this; below it an error rate is noise. */
  minimumAttempts?: number;
  /** Ignore Tier C on positions with fewer presses than this; below it a rate is noise. */
  minimumPresses?: number;
  limit?: number;
}

export function buildWeaknessModel(
  trainer: Database,
  meta: AnalysisMeta,
  metrics?: AnalysisMetrics,
  options: WeaknessOptions = {},
): WeaknessModel {
  const minimumAttempts = options.minimumAttempts ?? 20;
  // The same floor the viewer's correction layer draws with, and for the same reason: one
  // correction in two presses is not the worst key on the board, it is two samples.
  const minimumPresses = options.minimumPresses ?? 50;
  const limit = options.limit ?? 12;
  const byName = positionsByKeyName(meta);

  const sessionCount = Number(
    (trainer.query("SELECT COUNT(*) AS n FROM session WHERE ended_ts IS NOT NULL")
      .get() as { n: number }).n,
  );

  const expected = trainer.query(`
    SELECT k.expected_code, COUNT(*) AS attempts, SUM(1 - k.correct) AS errors
    FROM keystroke k JOIN session s ON s.id = k.session_id
    WHERE k.expected_code IS NOT NULL AND s.ended_ts IS NOT NULL
    GROUP BY k.expected_code
  `).all() as ExpectedRow[];
  const trainerByName = new Map(expected.map((row) => [row.expected_code, row]));
  const usableTrainerData = expected.some((row) => Number(row.attempts) >= minimumAttempts);

  // Tier B frequency. On its own frequency is not weakness — a key you press often is not a key you
  // press badly — so it only ever breaks ties and only ever contributes a minority of the score.
  const positionLoad = metrics?.positionLoad ?? meta.positions.map((position) => ({
    ...position,
    presses: 0,
  }));
  const maximumPresses = Math.max(1, ...positionLoad.map((position) => position.presses));

  // Tier C, as a rate rather than a count: the keys corrected most in absolute terms are simply the
  // keys pressed most, and scoring that would be scoring frequency twice under a different name.
  const context = metrics?.correctionTax.context;
  const correctedByPosition = new Map(
    (context?.byPosition ?? []).map((entry) => [entry.pos, entry]),
  );

  const scored: PositionWeakness[] = positionLoad
    .filter((position) => position.baseKeycode !== null)
    .map((position) => {
      const row = position.baseKeycode ? trainerByName.get(position.baseKeycode) : undefined;
      const attempts = row ? Number(row.attempts) : 0;
      const errorRate = row && attempts >= minimumAttempts
        ? Number(row.errors) / attempts
        : null;
      const frequency = position.presses / maximumPresses;
      const corrected = correctedByPosition.get(position.pos);
      const correctionRate = corrected && position.presses >= minimumPresses
        ? weightedCorrections(corrected.byLatency) / position.presses
        : null;
      const correctionScore = correctionRate === null
        ? 0
        : clamp01(correctionRate / CORRECTION_RATE_FULL_SCALE);
      const sources: WeaknessSource[] = [];
      if (errorRate !== null) sources.push("trainer");
      if (correctionRate !== null) sources.push("keylab-tier-c");
      if (position.presses > 0) sources.push("keylab-tier-b");
      // The ceilings are the ordering: frequency alone reaches 0.4, real-use corrections 0.8, and
      // only measured error against known text reaches 1. Frequency's weight falls as better
      // evidence arrives, or the most-pressed key would top every ranking whatever it measured —
      // which is the same mistake as drawing correction counts instead of correction rates.
      const score = errorRate !== null
        ? clamp01(errorRate * 0.7 + correctionScore * 0.2 + frequency * 0.1)
        : correctionRate !== null
          ? clamp01(correctionScore * 0.6 + frequency * 0.2)
          : clamp01(frequency * 0.4);
      return {
        pos: position.pos,
        label: position.baseKeycode?.replace(/^KEY_/, "") ?? String(position.pos),
        finger: position.finger,
        score,
        errorRate,
        attempts,
        presses: position.presses,
        corrections: corrected?.corrections ?? 0,
        correctionRate,
        sources,
      };
    });

  const usableCorrectionData = scored.some((position) =>
    position.sources.includes("keylab-tier-c"));
  const positions = scored
    .filter((position) => position.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const latencies = trainer.query(`
    SELECT previous.code AS from_code, current.code AS to_code,
           current.ts_ms - previous.ts_ms AS latency
    FROM keystroke current
    JOIN keystroke previous
      ON previous.session_id = current.session_id AND previous.seq = current.seq - 1
    JOIN session completed ON completed.id = current.session_id
    WHERE current.correct = 1 AND previous.correct = 1
      AND completed.ended_ts IS NOT NULL
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
    confidence: usableTrainerData
      ? "trainer"
      : usableCorrectionData ? "keylab-tier-c" : metrics ? "bootstrap" : "keymap",
    sessionCount,
    positions,
    bigrams,
    correctedTransitions: context ? correctedTransitions(meta, context, limit) : [],
    mechanics: metrics ? mechanicsFromTierA(metrics) : [],
  };
}
