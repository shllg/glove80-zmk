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
  id: string | number;
  text: string;
  keystrokes: PendingKeystroke[];
  corrections: PendingCorrection[];
  pendingCode: string | null;
  pendingDelete: boolean;
  value: string;
  wrongIndices: Set<number>;
}

export interface InputOutcome {
  kind: "keystroke" | "correction" | "outside" | "unsupported";
  complete: boolean;
  acceptedValue: string;
}

export interface InputProvenance {
  inputType: string;
  isComposing: boolean;
  trusted: boolean;
}

export function expectedCodeFor(character: string): string | null;
export function createTypingSession(id: string | number, text: string): TypingSession;
export function noteKeydown(session: TypingSession, event: { key: string; code: string }): void;
export function applyInput(
  session: TypingSession,
  typed: string,
  tsMs: number,
  provenance?: InputProvenance,
): InputOutcome;
