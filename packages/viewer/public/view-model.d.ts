export const PROFILE_CONFIRM_MS: number;

export interface StatusLine {
  text: string;
  isError: boolean;
}

export interface ControlTracker {
  request(profile: string, nowMs: number): void;
  reject(message: string): void;
  fail(message: string): void;
  observe(state: { profile: string }, nowMs: number): string;
  status(): StatusLine;
}

export function createControlTracker(confirmMs?: number): ControlTracker;

/** The fields the footnote reads, structurally a subset of the server's `CorrectionLayer`. */
export interface FootnoteLayer {
  latency: string;
  corrections: number;
  pressFloor: number;
  belowFloor: number;
  withoutPosition: { unattributed: number; absent: number; share: number };
}

export function percentage(value: number): string;
export function correctionFootnote(layer: FootnoteLayer): string;
export function rateLevel(rate: number, maximum: number): number;
