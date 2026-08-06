import type { AnalysisMeta } from "@glove80/analysis/meta";
import { corpus, DRILL_CORPUS_VERSION, seededRandom } from "./corpus";
import type { TransitionWeakness, WeaknessModel } from "./weakness";

/**
 * Four drill families. The first two are what any typing trainer does; the third is the one nothing
 * else can do, and the fourth is the one that makes the German cost visible.
 *
 * - **position** — weighted text emphasising the positions the weakness model ranks worst.
 * - **bigram/transition** — same-finger bigrams and awkward rolls.
 * - **mechanic** — hold/tap discrimination, layer-hold accuracy, thumb clusters, `LONELY_MOD`
 *   misfire rate. These are the mechanics of *this* firmware, and they are the reason to build
 *   rather than only fork: no word list will ever surface a 750 ms `R_GUI` hold.
 * - **language** — umlaut macro sequences, German compounds, code identifiers.
 *
 * Every generator draws from the *drill* pools. Generating from a benchmark pool would contaminate
 * the benchmark by practising the exact text it measures.
 */

export type DrillFamily = "position" | "bigram" | "mechanic" | "language";

export interface Drill {
  family: DrillFamily;
  corpusId: string;
  corpusVersion: string;
  language: string;
  seed: number;
  text: string;
  /** Why this drill was generated, in the user's terms. */
  rationale: string;
}

function weightedPick<T>(entries: ReadonlyArray<{ item: T; weight: number }>, random: () => number): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return (entries[0] as { item: T }).item;
  let target = random() * total;
  for (const entry of entries) {
    target -= entry.weight;
    if (target <= 0) return entry.item;
  }
  return (entries[entries.length - 1] as { item: T }).item;
}

/**
 * Position drill: sample words from the drill pool, weighted by how many weak letters they contain.
 * Words are still real words — drilling raw letter salad trains a motion you never actually make.
 */
export function generatePositionDrill(
  weakness: WeaknessModel,
  seed: number,
  options: { language?: string; wordCount?: number } = {},
): Drill {
  const language = options.language ?? "en";
  const wordCount = options.wordCount ?? 40;
  const pool = corpus(language === "de" ? "de-drill" : "en-drill");
  const weak = new Map(
    weakness.positions
      .filter((position) => /^[A-Z]$/.test(position.label))
      .map((position) => [position.label.toLowerCase(), position.score]),
  );
  const entries = pool.words.map((word) => {
    const weight = 1 + [...word].reduce((sum, letter) => sum + (weak.get(letter) ?? 0) * 4, 0);
    return { item: word, weight };
  });
  const random = seededRandom(seed);
  const words = Array.from({ length: wordCount }, () => weightedPick(entries, random));
  const targets = [...weak.keys()].slice(0, 6).join(", ");
  return {
    family: "position",
    corpusId: pool.id,
    corpusVersion: pool.version,
    language: pool.language,
    seed,
    text: words.join(" "),
    rationale: positionRationale(weakness.confidence, targets || "none yet"),
  };
}

/** The confidence label is the whole point: a drill built on frequency must not read like one built
 *  on measured error, and one built on real-use corrections is neither. */
function positionRationale(confidence: WeaknessModel["confidence"], targets: string): string {
  if (confidence === "trainer") {
    return `Weighted toward positions with the highest measured error rate: ${targets}.`;
  }
  if (confidence === "keylab-tier-c") {
    return "No trainer history yet, so weighting comes from the keys keylab saw you correct in "
      + `real work, per press rather than in total: ${targets}.`;
  }
  return "No trainer history yet, so weighting is bootstrapped from keylab position frequency: "
    + `${targets}.`;
}

/**
 * A degraded Tier C row names two fingers and no positions, so the only pairs it can drill are
 * whatever this keymap happens to put on those fingers. Bounded and ordered by position, because a
 * finger pair can otherwise expand into dozens of letter pairs and swamp the pool.
 */
function fingerPairs(meta: AnalysisMeta, fingers: [string, string], limit: number): string[] {
  const letters = (finger: string) => meta.positions
    .filter((position) => position.finger === finger
      && /^KEY_[A-Z]$/.test(position.baseKeycode ?? ""))
    .sort((left, right) => left.pos - right.pos)
    .map((position) => (position.baseKeycode as string).slice(4).toLowerCase());
  const [fromFinger, toFinger] = fingers;
  const pairs: string[] = [];
  for (const from of letters(fromFinger)) {
    for (const to of letters(toFinger)) {
      if (from === to) continue;
      pairs.push(`${from}${to}`);
      if (pairs.length >= limit) return pairs;
    }
  }
  return pairs;
}

/**
 * The pool a bigram drill draws from, weighted so a transition you had to *delete* after outranks
 * one you are merely slow at. Tier C is real-use evidence of error; the trainer's own latencies are
 * evidence of hesitation, and both belong in the pool.
 */
function transitionPool(weakness: WeaknessModel, meta: AnalysisMeta):
Array<{ item: string; weight: number }> {
  const weights = new Map<string, number>();
  const add = (pair: string, weight: number) => weights.set(pair, (weights.get(pair) ?? 0) + weight);
  const worst = Math.max(1, ...weakness.correctedTransitions.map((entry) => entry.weight));
  for (const transition of weakness.correctedTransitions) {
    const relative = transition.weight / worst;
    if (transition.letters !== null) {
      add(transition.letters, 1 + relative * 3);
    } else if (transition.fingers !== null) {
      for (const pair of fingerPairs(meta, transition.fingers, 2)) add(pair, 1 + relative);
    }
  }
  for (const bigram of weakness.bigrams
    .filter((entry) => entry.sameFinger || entry.medianLatencyMs > 0)
    .slice(0, 8)) {
    const letters = bigramLetters(bigram.from, bigram.to);
    if (letters) add(letters, 1);
  }
  if (weights.size === 0) {
    for (const pair of sameFingerBigrams(meta).slice(0, 8)) add(pair, 1);
  }
  return [...weights].map(([item, weight]) => ({ item, weight }));
}

/**
 * Bigram drill: the transitions your own corrections landed after, the slowest transitions the
 * trainer measured, and — before either exists — every same-finger bigram the keymap admits, which
 * is a property of the layout and worth drilling on day one.
 */
export function generateBigramDrill(
  weakness: WeaknessModel,
  meta: AnalysisMeta,
  seed: number,
  options: { repetitions?: number } = {},
): Drill {
  const repetitions = options.repetitions ?? 12;
  const pool = transitionPool(weakness, meta);
  const random = seededRandom(seed);
  const groups = Array.from({ length: repetitions }, () => {
    const pair = weightedPick(pool, random);
    return `${pair}${pair}${pair}`;
  });
  const corrected = weakness.correctedTransitions.length > 0;
  const measured = weakness.bigrams.some((bigram) => bigram.sameFinger || bigram.medianLatencyMs > 0);
  return {
    family: "bigram",
    corpusId: "generated-bigram",
    corpusVersion: DRILL_CORPUS_VERSION,
    language: "en",
    seed,
    text: groups.join(" "),
    rationale: corrected
      ? "Weighted toward the transitions keylab saw your corrections land after"
        + (measured ? ", plus the slowest transitions your trainer history measured." : ".")
      : measured
        ? "The slowest transitions actually measured in your own trainer history."
        : "No measured transitions yet, so these are the same-finger bigrams this keymap admits.",
  };
}

function bigramLetters(from: string, to: string): string | null {
  const first = /^Key([A-Z])$/.exec(from)?.[1];
  const second = /^Key([A-Z])$/.exec(to)?.[1];
  return first && second ? `${first}${second}`.toLowerCase() : null;
}

/** Two letters on the same finger of the same hand: the layout's built-in awkwardness. */
export function sameFingerBigrams(meta: AnalysisMeta): string[] {
  const letters = meta.positions.filter((position) =>
    position.baseKeycode !== null && /^KEY_[A-Z]$/.test(position.baseKeycode));
  const pairs: string[] = [];
  for (const first of letters) {
    for (const second of letters) {
      if (first.pos === second.pos || first.finger !== second.finger) continue;
      const a = first.baseKeycode?.slice(4).toLowerCase() ?? "";
      const b = second.baseKeycode?.slice(4).toLowerCase() ?? "";
      if (a && b) pairs.push(`${a}${b}`);
    }
  }
  return pairs.sort();
}

export interface MechanicDrillStep {
  instruction: string;
  target: string;
}

export interface MechanicDrill extends Drill {
  steps: MechanicDrillStep[];
}

/**
 * Mechanic drill. This is the differentiator: hold/tap discrimination on the home row mods, layer
 * holds, thumb clusters, and `LONELY_MOD` misfire rate — the mechanics of this firmware, which no
 * word-list drill can reach. Steps are generated from what the weakness model actually measured, so
 * a clean board produces a short drill rather than busywork.
 */
export function generateMechanicDrill(weakness: WeaknessModel, seed: number): MechanicDrill {
  const steps: MechanicDrillStep[] = [];
  for (const mechanic of weakness.mechanics.slice(0, 6)) {
    if (mechanic.kind === "hold-outlier") {
      const modifier = mechanic.label.replace(" hold", "");
      steps.push({
        instruction: `Hold ${modifier} and release it deliberately, ten times. `
          + `Measured: ${mechanic.detail}. Aim for a clean release under 250 ms.`,
        target: `${modifier} hold x10`,
      });
    } else if (mechanic.kind === "lonely-mod") {
      steps.push({
        instruction: "Tap each home row mod as its letter, then hold it as a modifier. "
          + `A lonely modifier means the hold resolved with nothing after it. Measured: ${mechanic.detail}.`,
        target: "a s d f  j k l ;  (tap, then hold+letter)",
      });
    } else if (mechanic.kind === "mod-during-alpha") {
      steps.push({
        instruction: "Type a word, then a shortcut, without pausing. A modifier pressed within "
          + `250 ms of a letter is the misfire this counts. Measured: ${mechanic.detail}.`,
        target: "select copy paste undo redo",
      });
    } else if (mechanic.kind === "finger-imbalance") {
      steps.push({
        instruction: `Deliberately unload that finger. Measured: ${mechanic.detail}.`,
        target: mechanic.label,
      });
    } else if (mechanic.kind === "correction-run") {
      steps.push({
        instruction: "Type slowly enough to not need backspace at all for one line. "
          + `Measured: ${mechanic.detail}.`,
        target: "accuracy over speed",
      });
    }
  }
  if (steps.length === 0) {
    steps.push({
      instruction: "No mechanic weakness measured in range. Hold each thumb-cluster key and "
        + "release it cleanly to keep the baseline current.",
      target: "thumb cluster sweep",
    });
  }
  return {
    family: "mechanic",
    corpusId: "generated-mechanic",
    corpusVersion: DRILL_CORPUS_VERSION,
    language: "en",
    seed,
    text: steps.map((step) => step.target).join("\n"),
    rationale: "Generated from keylab Tier A: firmware mechanics no word list can surface.",
    steps,
  };
}

/**
 * Language drill. On this keymap an umlaut is an eight-keystroke macro, so a German drill is really
 * a drill on that macro. Code identifiers are here too because they are a third language with its
 * own shape: symbols, camelCase, and underscores in places prose never puts them.
 */
export function generateLanguageDrill(
  seed: number,
  options: { language?: string; wordCount?: number; identifiers?: readonly string[] } = {},
): Drill {
  const language = options.language ?? "de";
  const wordCount = options.wordCount ?? 30;
  const random = seededRandom(seed);
  if (language === "code") {
    const pool = options.identifiers && options.identifiers.length > 0
      ? options.identifiers
      : DEFAULT_IDENTIFIERS;
    const words = Array.from(
      { length: wordCount },
      () => pool[Math.floor(random() * pool.length)] as string,
    );
    return {
      family: "language",
      corpusId: "generated-identifiers",
      corpusVersion: DRILL_CORPUS_VERSION,
      language: "code",
      seed,
      text: words.join(" "),
      rationale: "Code identifiers: symbols and case changes prose never asks for.",
    };
  }
  const pool = corpus(language === "de" ? "de-drill" : "en-drill");
  const umlautWords = pool.words.filter((word) => /[äöüß]/.test(word));
  const source = language === "de" && umlautWords.length > 0 ? umlautWords : pool.words;
  const words = Array.from(
    { length: wordCount },
    () => source[Math.floor(random() * source.length)] as string,
  );
  return {
    family: "language",
    corpusId: pool.id,
    corpusVersion: pool.version,
    language: pool.language,
    seed,
    text: words.join(" "),
    rationale: language === "de"
      ? "Umlaut-dense: every ä/ö/ü costs eight keystrokes through the Chars-layer macro, so this "
        + "drills the macro, not the letter."
      : "Drill pool, deliberately disjoint from the benchmark pool.",
  };
}

const DEFAULT_IDENTIFIERS = [
  "buildWeaknessModel", "calculateMetrics", "device_id", "keymap_meta_path", "profile_id",
  "seal_or_discard_tier_a", "tier_b_seal_count", "replace_live_snapshot", "MAX_PROFILES",
  "auto_revert_idle_seconds", "positionStructuredLayout", "orderByGlove80Geometry",
] as const;
