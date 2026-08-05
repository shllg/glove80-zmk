import type { KeystrokeRecord } from "./store";

export interface SessionScore {
  keystrokes: number;
  correct: number;
  accuracy: number;
  elapsedMs: number;
  /** Standard 5-characters-per-word convention, counted over correct keystrokes only. */
  wpm: number;
  /**
   * How many characters arrived with no physical key attached. On this host that is the IBus
   * question: if a composed character reaches the application without a `keydown`, the browser
   * cannot attribute German physically and only keylab sees the real eight-keystroke cost.
   */
  unattributedCharacters: number;
}

export const COMPOSED_CODE = "Composed";

export function scoreSession(keystrokes: readonly KeystrokeRecord[]): SessionScore {
  if (keystrokes.length === 0) {
    return {
      keystrokes: 0, correct: 0, accuracy: 0, elapsedMs: 0, wpm: 0, unattributedCharacters: 0,
    };
  }
  const times = keystrokes.map((keystroke) => keystroke.tsMs);
  const elapsedMs = Math.max(0, Math.max(...times) - Math.min(...times));
  const correct = keystrokes.filter((keystroke) => keystroke.correct).length;
  const unattributedCharacters = keystrokes
    .filter((keystroke) => keystroke.code === COMPOSED_CODE).length;
  const minutes = elapsedMs / 60_000;
  return {
    keystrokes: keystrokes.length,
    correct,
    accuracy: keystrokes.length === 0 ? 0 : correct / keystrokes.length,
    elapsedMs,
    wpm: minutes > 0 ? correct / 5 / minutes : 0,
    unattributedCharacters,
  };
}

/**
 * A rolling median over the last k runs, not a raw last-run figure.
 *
 * With a random seed per run, a single run's WPM carries real sampling noise; a median over a short
 * window keeps the trend readable without smoothing away a genuine change. Only `benchmark` rows
 * belong here — plotting drills would show improvement at whatever the weakness model chose to
 * practise, which is not a benchmark.
 */
export function rollingMedian(values: readonly number[], window = 5): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1);
    const slice = [...values.slice(start, index + 1)].sort((left, right) => left - right);
    const middle = Math.floor(slice.length / 2);
    return slice.length % 2 === 1
      ? (slice[middle] as number)
      : (((slice[middle - 1] as number) + (slice[middle] as number)) / 2);
  });
}
