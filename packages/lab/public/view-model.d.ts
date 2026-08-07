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
export function applyStatus(
  target: { textContent: string | null; classList: { toggle(name: string, force?: boolean): boolean } },
  text: string,
  isError?: boolean,
): void;
export interface RouteTracker {
  current(): string;
  leaves(nextRoute: string): boolean;
  commit(nextRoute: string, nextLocation?: string): void;
  replaceLocation(nextLocation: string): void;
}
export function createRouteTracker(initialRoute: string, initialLocation?: string): RouteTracker;
export function mechanicAvailable(health: {
  service: string;
  capture: string;
  paused: boolean;
} | null): boolean;
export function trainingErrorIsTerminal(code: string | undefined): boolean;
export function recommendedDrill(model: {
  positions?: unknown[];
  correctedTransitions?: unknown[];
  bigrams?: unknown[];
  mechanics?: unknown[];
}): "position" | "bigram" | "mechanic" | "language";
export function fingerLabel(finger: { label: string; share: number }): string;
export function positionalSummary(context: {
  unattributedShare: number;
  unattributedPresses: number;
  tierBKeystrokes: number;
  unreliable: boolean;
}): string;
export function misfireSummary(
  kind: { kind: number; count: number; per1000: number; byModClass: Array<{ label: string; count: number; per1000: number }> },
  misfires: { targetPercent: number; lonelyModTargetMet: boolean },
): string;
export function correctionContextSummary(context: {
  windowCount: number;
  corrections: number;
  degraded: number;
  degradedShare: number;
  dropped: number;
  droppedShare: number;
  distinctNgrams: number;
  distinctFingerNgrams: number;
  topNgrams: unknown[];
  byFinger: unknown[];
  byLatency: Record<"fumble" | "ambiguous" | "edit", number>;
}): { headline: string; latency: string; top: string; fingers: string } | null;
export function correctionFootnote(layer: FootnoteLayer): string;
export function rateLevel(rate: number, maximum: number): number;
