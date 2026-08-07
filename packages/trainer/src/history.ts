import { attributeCorrections, type CorrectionAttribution } from "./corrections";
import { rollingMedian, scoreSession, type SessionScore } from "./scoring";
import type { SessionMode, SessionRecord, TrainerStore } from "./store";

export interface BenchmarkPoint {
  sessionId: number;
  startedTs: number;
  language: string;
  corpusId: string;
  corpusVersion: string;
  wpm: number;
  accuracy: number;
  unattributedCharacters: number;
  corrections: CorrectionAttribution;
}

export interface BenchmarkHistory {
  points: BenchmarkPoint[];
  /** Per language, in run order, so German is only ever compared with German. */
  rollingMedianWpm: Record<string, number[]>;
}

export interface SessionSummary {
  session: SessionRecord;
  score: SessionScore | null;
  corrections: CorrectionAttribution;
}

export interface SessionHistoryOptions {
  mode?: SessionMode;
  language?: string;
  limit?: number;
}

function summarise(store: TrainerStore, session: SessionRecord): SessionSummary {
  const keystrokes = store.keystrokes(session.id);
  const corrections = store.corrections(session.id);
  return {
    session,
    // Mechanic drills are guided physical exercises. Zero WPM would falsely read as a result.
    score: session.drillFamily === "mechanic" ? null : scoreSession(keystrokes),
    corrections: attributeCorrections(session.text ?? "", corrections, keystrokes),
  };
}

export function sessionHistory(
  store: TrainerStore,
  options: SessionHistoryOptions = {},
): SessionSummary[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return store.sessions(options.mode)
    .filter((session) => session.endedTs !== null)
    .filter((session) => options.language === undefined || session.language === options.language)
    .slice(-limit)
    .reverse()
    .map((session) => summarise(store, session));
}

export function sessionDetail(store: TrainerStore, sessionId: number): SessionSummary | null {
  const session = store.session(sessionId);
  if (!session || session.endedTs === null) return null;
  return summarise(store, session);
}

export function benchmarkHistory(store: TrainerStore): BenchmarkHistory {
  const points: BenchmarkPoint[] = [];
  for (const { session, score, corrections } of sessionHistory(store, {
    mode: "benchmark",
    limit: 500,
  }).reverse()) {
    if (score === null) continue;
    points.push({
      sessionId: session.id,
      startedTs: session.startedTs,
      language: session.language,
      corpusId: session.corpusId,
      corpusVersion: session.corpusVersion,
      wpm: score.wpm,
      accuracy: score.accuracy,
      unattributedCharacters: score.unattributedCharacters,
      corrections,
    });
  }
  const rollingMedianWpm: Record<string, number[]> = {};
  for (const language of new Set(points.map((point) => point.language))) {
    rollingMedianWpm[language] = rollingMedian(
      points.filter((point) => point.language === language).map((point) => point.wpm),
    );
  }
  return { points, rollingMedianWpm };
}
