import { LATENCY_CLASS_LABELS, type LatencyClass } from "@glove80/analysis/metrics";
import type { CorrectionRecord, KeystrokeRecord } from "./store";

/**
 * The fumble/edit thresholds, in milliseconds, shared with keylab's Tier C.
 *
 * Rust and TypeScript cannot share a constant, so this is the TypeScript half of a pinned pair:
 * `latency_bucket` in `crates/keylab/src/encode.rs` carries a comment naming this file, and both
 * sides carry a test asserting these four boundaries. If they ever drift, the fumble/edit split
 * means two different things in the two instruments and every cross-instrument comparison is
 * silently wrong — which is the only kind of wrong that never gets noticed.
 */
export const LATENCY_BUCKET_BOUNDARIES_MS = [150, 400, 1_000] as const;

export { LATENCY_CLASS_LABELS, type LatencyClass };

/** 0 and 1 are fumbles, 2 is ambiguous, 3 is an edit. Mirrors `encode.rs::latency_bucket`. */
export function latencyBucket(ms: number): number {
  const [fumble, slowFumble, ambiguous] = LATENCY_BUCKET_BOUNDARIES_MS;
  if (ms < fumble) return 0;
  if (ms < slowFumble) return 1;
  if (ms < ambiguous) return 2;
  return 3;
}

export interface WordCorrections {
  word: string;
  /** How many times the prompt asked for this word, so a rate can be read off the count. */
  occurrences: number;
  corrections: number;
  /** Corrections per occurrence. Above 1 when a word was corrected more than once per attempt. */
  correctionRate: number;
  /** Character offsets inside the word, most corrected first: "always the third letter". */
  offsets: Array<{ offset: number; count: number }>;
}

export interface TransitionCorrections {
  /** The digraph immediately before the deleted character, e.g. `"th"` for a fumble on `e`. */
  transition: string;
  corrections: number;
}

export interface CorrectionAttribution {
  corrections: number;
  /** Sum of run lengths: a held Backspace removes several characters in one correction. */
  charactersRemoved: number;
  byLatency: Record<LatencyClass, number>;
  words: WordCorrections[];
  transitions: TransitionCorrections[];
  /**
   * Corrections whose `charIndex` falls outside the session text — typing past the end of the
   * prompt and deleting it again. Reported rather than dropped, so the word table's total can be
   * checked against `corrections` instead of quietly disagreeing with it.
   */
  unattributed: number;
}

interface Word {
  word: string;
  start: number;
  end: number;
}

/**
 * Words are the units the corpus generated. Split on whitespace against the session text; do not
 * re-tokenise heuristically, or the trainer starts reporting corrections against words the drill
 * never asked for.
 */
function splitWords(text: string): Word[] {
  const words: Word[] = [];
  const pattern = /\S+/g;
  let match = pattern.exec(text);
  while (match !== null) {
    words.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return words;
}

/**
 * A correction whose character is a space belongs to the word that just ended: the space was typed
 * as part of finishing that word, and blaming the word about to start would attribute a mistake to
 * text the hand had not reached yet.
 */
function wordAt(words: readonly Word[], charIndex: number): number {
  for (const [index, word] of words.entries()) {
    if (charIndex < word.start) return index === 0 ? -1 : index - 1;
    if (charIndex < word.end) return index;
  }
  return words.length === 0 ? -1 : words.length - 1;
}

function emptyLatency(): Record<LatencyClass, number> {
  const byLatency = {} as Record<LatencyClass, number>;
  for (const label of LATENCY_CLASS_LABELS) byLatency[label] = 0;
  return byLatency;
}

/**
 * Attributes each correction to the word and transition being typed, using text the trainer
 * generated and therefore knows the ground truth for. This is the thing keylab's Tier C cannot do:
 * Tier C sees positions, never which word was intended.
 */
export function attributeCorrections(
  text: string,
  corrections: readonly CorrectionRecord[],
  keystrokes: readonly KeystrokeRecord[],
): CorrectionAttribution {
  const words = splitWords(text);
  const occurrences = new Map<string, number>();
  for (const { word } of words) occurrences.set(word, (occurrences.get(word) ?? 0) + 1);

  const byLatency = emptyLatency();
  const perWord = new Map<string, Map<number, number>>();
  const perTransition = new Map<string, number>();
  const times = [...keystrokes].map((keystroke) => keystroke.tsMs).sort((a, b) => a - b);
  let charactersRemoved = 0;
  let unattributed = 0;

  for (const correction of corrections) {
    charactersRemoved += correction.runLength;

    // Latency runs from the last keystroke before the correction, matching Tier C's "last
    // non-backspace keydown to the start of the backspace run". With no preceding keystroke there
    // is nothing to have fumbled, so it lands in the open-ended edit bucket, as Tier C does.
    let previous: number | undefined;
    for (const time of times) {
      if (time > correction.tsMs) break;
      previous = time;
    }
    const bucket = previous === undefined ? 3 : latencyBucket(correction.tsMs - previous);
    const label = LATENCY_CLASS_LABELS[bucket] as LatencyClass;
    byLatency[label] += 1;

    if (correction.charIndex < 0 || correction.charIndex >= text.length) {
      unattributed += 1;
      continue;
    }
    const index = wordAt(words, correction.charIndex);
    const word = words[index];
    if (word === undefined) {
      unattributed += 1;
      continue;
    }
    const offsets = perWord.get(word.word) ?? new Map<number, number>();
    // Clamped at the word's own length: a correction on the space after a word attributes to that
    // word, and its offset is the space, one past the last letter.
    const offset = Math.max(0, correction.charIndex - word.start);
    offsets.set(offset, (offsets.get(offset) ?? 0) + 1);
    perWord.set(word.word, offsets);

    if (correction.charIndex >= 2) {
      const digraph = text.slice(correction.charIndex - 2, correction.charIndex);
      perTransition.set(digraph, (perTransition.get(digraph) ?? 0) + 1);
    }
  }

  const wordRows: WordCorrections[] = [...perWord.entries()].map(([word, offsets]) => {
    const total = [...offsets.values()].reduce((sum, count) => sum + count, 0);
    const seen = occurrences.get(word) ?? 0;
    return {
      word,
      occurrences: seen,
      corrections: total,
      correctionRate: seen === 0 ? 0 : total / seen,
      offsets: [...offsets.entries()]
        .map(([offset, count]) => ({ offset, count }))
        .sort((left, right) => right.count - left.count || left.offset - right.offset),
    };
  }).sort((left, right) => right.corrections - left.corrections || left.word.localeCompare(right.word));

  const transitions: TransitionCorrections[] = [...perTransition.entries()]
    .map(([transition, count]) => ({ transition, corrections: count }))
    .sort((left, right) => right.corrections - left.corrections
      || left.transition.localeCompare(right.transition));

  return {
    corrections: corrections.length,
    charactersRemoved,
    byLatency,
    words: wordRows,
    transitions,
    unattributed,
  };
}
