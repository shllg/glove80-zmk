export const COMPOSED_CODE: "Composed";

export interface PendingKeystroke {
  tsMs: number;
  code: string;
  expectedCode: string | null;
  correct: boolean;
}

export interface PendingCorrection {
  tsMs: number;
  charIndex: number;
  runLength: number;
  expectedCode: string | null;
}

export interface TypingSession {
  id: number;
  text: string;
  keystrokes: PendingKeystroke[];
  corrections: PendingCorrection[];
  pendingCode: string | null;
  pendingDelete: boolean;
  lastLength: number;
  wrongIndices: Set<number>;
}

export interface InputOutcome {
  kind: "keystroke" | "correction" | "outside";
  complete: boolean;
}

export function expectedCodeFor(character: string): string | null;
export function createTypingSession(id: number, text: string): TypingSession;
export function noteKeydown(session: TypingSession, event: { key: string; code: string }): void;
export function applyInput(session: TypingSession, typed: string, tsMs: number): InputOutcome;
