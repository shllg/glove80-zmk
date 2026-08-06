import type { Database } from "bun:sqlite";
import type { AnalysisMeta, Hand, PositionMeta } from "./meta";

export const FINGER_LABELS = [
  "L_index", "L_middle", "L_ring", "L_pinky", "L_thumb",
  "R_index", "R_middle", "R_ring", "R_pinky", "R_thumb",
] as const;

export const MOD_CLASS_LABELS = [
  "L_CTRL", "L_ALT", "L_GUI", "L_SHIFT",
  "R_CTRL", "R_ALT", "R_GUI", "R_SHIFT",
] as const;

export const EVENT_KIND_LABELS = [
  "LONELY_MOD", "MOD_DURING_ALPHA", "BSP_BURST_AFTER_MOD",
] as const;

/**
 * Tier C latency buckets, measured from the last non-backspace keydown to the start of the backspace
 * run. The split is what separates mistyping from ordinary rewriting; without it the table mixes the
 * two and the answer is polluted. Bucket 3 also carries "no preceding key", which reads as an edit.
 */
export const LATENCY_CLASS_LABELS = ["fumble", "fumble", "ambiguous", "edit"] as const;

export type LatencyClass = (typeof LATENCY_CLASS_LABELS)[number];

/** Backspace run buckets, as `encode.rs::run_bucket` cuts them. Bucket 6 is open-ended. */
export const RUN_BUCKET_LABELS = ["1", "2", "3", "4", "5-8", "9-16", "17+"] as const;

/** Tier C position sentinels, matching the daemon's on-disk encoding. */
export const POSITION_UNATTRIBUTED = -1;
export const POSITION_ABSENT = -2;

/** Tier C finger sentinel. Fingers are `0..9`; `-1` means the slot held no key at all. */
export const FINGER_ABSENT = -1;

/**
 * How many aggregated rows `getCorrectionContext` returns. The full distinct-row counts ride along
 * so a caller can say how much it is not showing — a truncated list that reads as complete would
 * make a long tail of rare fumbles look like it does not exist.
 */
export const TOP_NGRAM_LIMIT = 20;

export type SinceValue = "30m" | "24h" | "7d" | "all";
export type ViewerRangeValue = "live" | "today" | "7d" | "all";

export interface TimeRange {
  label: string;
  sinceTs: number | null;
  nowTs: number;
}

/** `"*"` pools every profile; any other name is resolved against the `profile` table. */
export const ALL_PROFILES = "*";
export const ALL_PROFILES_LABEL = "* (all profiles)";

export const ALL_DEVICES = "*";
export const ALL_DEVICES_LABEL = "* (all devices)";

export interface MetricsOptions {
  profile?: string;
  /** A device id, or `"*"` to pool. Tier A pools freely; Tier B does not — see the guard below. */
  device?: number | string;
}

/** `null` means "no profile clause at all", which is how pooling is expressed. */
export interface ProfileScope {
  id: number | null;
  label: string;
}

export interface DeviceScope {
  id: number | null;
  label: string;
}

export interface PositionalContext {
  tierBKeystrokes: number;
  attributedPresses: number;
  unattributedPresses: number;
  unattributedShare: number;
  unreliable: boolean;
}

export interface HistogramBin {
  bucket: number;
  midpointMs: number;
  count: number;
  openEnded: boolean;
}

export interface EstimatedDuration {
  ms: number;
  openEnded: boolean;
  label: string;
}

export interface FingerLoad {
  fingerId: number;
  label: string;
  hand: Hand;
  presses: number;
  share: number;
}

export interface RowLoad {
  hand: Hand;
  rowIdx: number;
  presses: number;
  share: number;
  handShare: number;
}

export interface ModifierHoldMetric {
  modClass: number;
  label: string;
  count: number;
  total: EstimatedDuration;
  median: EstimatedDuration;
  p95: EstimatedDuration;
  histogram: HistogramBin[];
}

export interface MisfireClassMetric {
  modClass: number;
  label: string;
  count: number;
  per1000: number;
}

export interface MisfireKindMetric {
  kind: number;
  label: string;
  count: number;
  per1000: number;
  byModClass: MisfireClassMetric[];
}

export interface DailyDoseEntry {
  date: string;
  keystrokes: number;
  holdHours: number;
}

export interface PositionLoad {
  pos: number;
  hand: Hand;
  row: number;
  col: number | null;
  finger: string;
  baseKeycode: string | null;
  presses: number;
}

/** One aggregated ordered trigram of physical positions that preceded a correction. */
export interface NgramEntry {
  positions: [number, number, number];
  /** The three base-layer bindings, in typing order. `?` is unknown, `·` is absent. */
  characters: string;
  count: number;
  latencyBucket: number;
  latencyClass: LatencyClass;
  runBucket: number;
  runLabel: string;
  modMask: number;
  modLabels: string[];
}

/** The finger-level projection a trigram degrades to when it was too rare to keep its positions. */
export interface FingerNgramEntry {
  fingers: [number, number, number];
  /** The three finger labels, in typing order. `·` is absent. */
  labels: string;
  count: number;
  latencyBucket: number;
  latencyClass: LatencyClass;
  runBucket: number;
  runLabel: string;
  modMask: number;
  modLabels: string[];
}

/**
 * One position's share of the `pos_c` marginal: how often it was the last key pressed before a
 * correction. `pos_c` is the key immediately before the backspace, which is the one a heatmap wants;
 * `pos_a` and `pos_b` are the run-up to it.
 */
export interface CorrectedPosition {
  pos: number;
  corrections: number;
  byLatency: Record<LatencyClass, number>;
}

export interface CorrectionContext {
  windowCount: number;
  corrections: number;
  degraded: number;
  dropped: number;
  degradedShare: number;
  droppedShare: number;
  distinctNgrams: number;
  distinctFingerNgrams: number;
  topNgrams: NgramEntry[];
  byFinger: FingerNgramEntry[];
  /** Totals over every correction that kept its latency, so these sum to `corrections - dropped`. */
  byLatency: Record<LatencyClass, number>;
  /**
   * The `pos_c` marginal over every n-gram row in range, not only the `topNgrams` shown. Real
   * positions only, worst first.
   */
  byPosition: CorrectedPosition[];
  /**
   * The two sentinels, kept out of `byPosition` because neither has geometry: `-1` is a key with no
   * base-layer position, `-2` a correction with no key before it at all. A drawing excludes them; a
   * total that hides them would not add up.
   */
  withoutPosition: { unattributed: CorrectedPosition; absent: CorrectedPosition };
}

export interface RangeMetrics {
  range: TimeRange;
  header: {
    profile: string;
    device: string;
    positionSpace: string | null;
    totalKeystrokes: number;
    autorepeats: number;
    bucketCount: number;
    tierBWindowCount: number;
    altHandAmbiguous: boolean;
    noData: boolean;
  };
  perFinger: FingerLoad[];
  perRow: RowLoad[];
  outerUpperQuadrant: {
    source: "Tier B";
    excludesUnattributed: true;
    byHand: Array<{
      hand: Hand;
      presses: number;
      attributedHandPresses: number;
      share: number;
    }>;
    positional: PositionalContext;
  };
  modifierHolds: ModifierHoldMetric[];
  misfires: {
    targetPercent: number;
    lonelyModTargetMet: boolean;
    kinds: MisfireKindMetric[];
  };
  correctionTax: {
    positionalBackspacePresses: number;
    positionalShare: number;
    burstEstimatedBackspacePresses: number;
    burstShare: number;
    burstEstimateOpenEnded: boolean;
    runHistogram: Array<{ bucket: number; midpoint: number; count: number; openEnded: boolean }>;
    positional: PositionalContext;
    context: CorrectionContext;
  };
  dailyDose: {
    days: DailyDoseEntry[];
    dayCount: number;
    keystrokesPerDay: number;
    holdHoursPerDay: number;
  };
  positionLoad: PositionLoad[];
}

export interface AnalysisMetrics extends RangeMetrics {
  fatigueDrift: Array<{ hour: number; metrics: RangeMetrics }>;
}

interface CountRow {
  id: number;
  presses: number;
}

interface RowCountRow {
  hand: number;
  row_idx: number;
  presses: number;
}

interface HistRow {
  subject: number;
  bucket: number;
  n: number;
}

interface EventRow {
  kind: number;
  subject: number;
  n: number;
}

interface PositionRow {
  pos: number;
  presses: number;
}

interface TotalsRow {
  total: number | null;
  autorepeats: number | null;
  count: number;
}

interface ScalarRow {
  value: number | null;
}

interface DayRow {
  date: string;
  keystrokes: number;
}

interface DayHistRow {
  date: string;
  bucket: number;
  n: number;
}

interface NgramRow {
  a: number;
  b: number;
  c: number;
  mod_mask: number;
  latency_bucket: number;
  run_bucket: number;
  n: number;
}

interface NgramWindowRow {
  windows: number;
  corrections: number | null;
  degraded: number | null;
  dropped: number | null;
}

const DURATION_BUCKETS = Array.from({ length: 22 }, (_, bucket) => bucket);

export function parseSince(value: string, nowTs = Math.floor(Date.now() / 1000)): TimeRange {
  if (value === "all") {
    return { label: "all", sinceTs: null, nowTs };
  }
  const match = /^(30m|24h|7d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid range ${JSON.stringify(value)}; expected 30m, 24h, 7d, or all`);
  }
  const seconds = value === "30m" ? 1_800 : value === "24h" ? 86_400 : 604_800;
  return { label: value, sinceTs: nowTs - seconds, nowTs };
}

export function parseViewerRange(
  value: string,
  nowTs = Math.floor(Date.now() / 1000),
): TimeRange {
  if (value === "7d" || value === "all") {
    return parseSince(value, nowTs);
  }
  if (value === "live") {
    return { label: "live (last 30m)", sinceTs: nowTs - 1_800, nowTs };
  }
  if (value === "today") {
    const start = new Date(nowTs * 1000);
    start.setHours(0, 0, 0, 0);
    return { label: "today", sinceTs: Math.floor(start.getTime() / 1000), nowTs };
  }
  throw new Error(`Invalid viewer range ${JSON.stringify(value)}; expected live, today, 7d, or all`);
}

export function durationBucketMidpoint(bucket: number): number {
  if (bucket >= 0 && bucket <= 19) return bucket * 25 + 12.5;
  if (bucket === 20) return 750;
  if (bucket === 21) return 1_000;
  throw new Error(`Invalid duration bucket ${bucket}`);
}

export function histogramPercentile(
  histogram: ReadonlyMap<number, number>,
  percentile: number,
): EstimatedDuration {
  const total = [...histogram.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return estimatedDuration(0, false);
  const threshold = Math.ceil(total * percentile);
  let cumulative = 0;
  for (const bucket of DURATION_BUCKETS) {
    cumulative += histogram.get(bucket) ?? 0;
    if (cumulative >= threshold) {
      return estimatedDuration(durationBucketMidpoint(bucket), bucket === 21);
    }
  }
  return estimatedDuration(1_000, true);
}

function estimatedDuration(ms: number, openEnded: boolean): EstimatedDuration {
  return { ms, openEnded, label: `${openEnded ? ">=" : "~"}${formatNumber(ms)} ms` };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Resolves the requested profile once, before any query runs. An unknown name is an error rather
 * than an empty result: a silent zero would read as "you did not type in that profile".
 */
export function resolveProfileScope(database: Database, profile?: string): ProfileScope {
  if (profile === ALL_PROFILES) {
    return { id: null, label: ALL_PROFILES_LABEL };
  }
  const name = profile ?? "default";
  const row = database
    .query("SELECT id FROM profile WHERE name = ?")
    .get(name) as { id: number } | null;
  if (!row) {
    const known = (database.query("SELECT name FROM profile ORDER BY id").all() as Array<{
      name: string;
    }>).map((entry) => entry.name);
    throw new Error(
      `Unknown profile ${JSON.stringify(name)}; this database holds: ${known.join(", ") || "(none)"}`,
    );
  }
  return { id: Number(row.id), label: name };
}

export function resolveDeviceScope(database: Database, device?: number | string): DeviceScope {
  if (device === undefined || device === ALL_DEVICES) {
    return { id: null, label: ALL_DEVICES_LABEL };
  }
  const id = Number(device);
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid device ${JSON.stringify(device)}; expected an id or "*"`);
  }
  const row = database
    .query("SELECT name FROM device WHERE id = ?")
    .get(id) as { name: string } | null;
  if (!row) {
    throw new Error(`Unknown device id ${id}`);
  }
  return { id, label: `${id} (${row.name})` };
}

/**
 * The window table each positional tier seals into, keyed by the tier name the guard prints. Keeping
 * it a closed map rather than a free table argument means no caller can splice a table name into the
 * guard's SQL, and the error always names the read that actually failed.
 */
const POSITION_SPACE_SOURCES = {
  "Tier B": { table: "key_window", subject: "positional data" },
  "Tier C": { table: "ngram_window", subject: "correction-context n-grams" },
} as const;

export type PositionSpaceTier = keyof typeof POSITION_SPACE_SOURCES;

/**
 * **Tier A is semantic and crosses keyboards.** `finger_id`, `hand`, `row_idx`, hold and gap
 * histograms mean the same thing on any board, so pooling them answers "am I slower and more
 * pinky-loaded on the laptop?".
 *
 * **Tier B is geometric and must never be pooled across position spaces.** `pos` only means
 * something inside one keyboard's geometry: position 35 is `A` on the Glove80 and something else
 * entirely on a row-staggered board. Summing them produces a heatmap of nothing.
 *
 * **Tier C is geometric too.** An ordered position trigram is meaningless once two keyboards'
 * geometries are mixed into it, so the same guard runs over `ngram_window`.
 *
 * This is the invariant most likely to be violated silently, so it throws rather than returning a
 * plausible-looking number.
 */
export function assertSinglePositionSpace(
  database: Database,
  device: DeviceScope,
  profile: ProfileScope,
  range: TimeRange,
  tier: PositionSpaceTier = "Tier B",
): string | null {
  const source = POSITION_SPACE_SOURCES[tier];
  const clauses = ["kw.start_ts <= ?"];
  const params: Array<number | string> = [range.nowTs];
  if (range.sinceTs !== null) {
    clauses.unshift("kw.start_ts >= ?");
    params.unshift(range.sinceTs);
  }
  if (device.id !== null) {
    clauses.push("kw.device_id = ?");
    params.push(device.id);
  }
  if (profile.id !== null) {
    clauses.push("kw.profile_id = ?");
    params.push(profile.id);
  }
  const spaces = database.query(`
    SELECT DISTINCT COALESCE(d.keymap_kind, 'unknown') AS kind
    FROM ${source.table} kw JOIN device d ON d.id = kw.device_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY kind
  `).all(...params) as Array<{ kind: string }>;
  if (spaces.length > 1) {
    throw new Error(
      `Refusing to pool ${tier} ${source.subject} across `
      + `${spaces.length} position spaces (${spaces.map((space) => space.kind).join(", ")}). `
      + "Position identity only means something inside one keyboard's geometry; "
      + "select a single device with the device option.",
    );
  }
  return spaces[0]?.kind ?? null;
}

/**
 * The profile and device clauses ride along with the time clause because every scoped query already
 * joins the table that carries both foreign keys. Deriving the alias from the timestamp column
 * keeps them from ever being applied to different tables.
 */
function timestampFilter(
  column: string,
  range: TimeRange,
  hour: number | undefined,
  profile: ProfileScope,
  device: DeviceScope,
): { sql: string; params: number[] } {
  const clauses: string[] = [];
  const params: number[] = [];
  if (range.sinceTs !== null) {
    clauses.push(`${column} >= ?`);
    params.push(range.sinceTs);
  }
  clauses.push(`${column} <= ?`);
  params.push(range.nowTs);
  if (hour !== undefined) {
    clauses.push(`CAST(strftime('%H', ${column}, 'unixepoch', 'localtime') AS INTEGER) = ?`);
    params.push(hour);
  }
  const alias = column.split(".")[0];
  if (profile.id !== null) {
    clauses.push(`${alias}.profile_id = ?`);
    params.push(profile.id);
  }
  if (device.id !== null) {
    clauses.push(`${alias}.device_id = ?`);
    params.push(device.id);
  }
  return { sql: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "), params };
}

function getTotals(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): TotalsRow {
  const filter = timestampFilter("b.ts", range, hour, profile, device);
  return database.query(`
    SELECT COALESCE(SUM(b.keystrokes), 0) AS total,
           COALESCE(SUM(b.autorepeats), 0) AS autorepeats,
           COUNT(*) AS count
    FROM bucket b WHERE ${filter.sql}
  `).get(...filter.params) as TotalsRow;
}

function getTierBWindowCount(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): number {
  const filter = timestampFilter("kw.start_ts", range, hour, profile, device);
  const row = database.query(`
    SELECT COUNT(*) AS value FROM key_window kw WHERE ${filter.sql}
  `).get(...filter.params) as ScalarRow;
  return Number(row.value ?? 0);
}

function getFingerLoad(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): FingerLoad[] {
  const filter = timestampFilter("b.ts", range, hour, profile, device);
  const rows = database.query(`
    SELECT fc.finger_id AS id, SUM(fc.presses) AS presses
    FROM finger_count fc JOIN bucket b ON b.id = fc.bucket_id
    WHERE ${filter.sql}
    GROUP BY fc.finger_id
  `).all(...filter.params) as CountRow[];
  const counts = new Map(rows.map((row) => [Number(row.id), Number(row.presses)]));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return FINGER_LABELS.map((label, fingerId) => {
    const presses = counts.get(fingerId) ?? 0;
    return {
      fingerId,
      label,
      hand: fingerId < 5 ? "L" : "R",
      presses,
      share: safeDivide(presses, total),
    };
  });
}

function getRowLoad(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): RowLoad[] {
  const filter = timestampFilter("b.ts", range, hour, profile, device);
  const rows = database.query(`
    SELECT rc.hand, rc.row_idx, SUM(rc.presses) AS presses
    FROM row_count rc JOIN bucket b ON b.id = rc.bucket_id
    WHERE ${filter.sql}
    GROUP BY rc.hand, rc.row_idx
  `).all(...filter.params) as RowCountRow[];
  const counts = new Map(rows.map((row) => [`${row.hand}:${row.row_idx}`, Number(row.presses)]));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const handTotals = [0, 1].map((hand) => rows
    .filter((row) => Number(row.hand) === hand)
    .reduce((sum, row) => sum + Number(row.presses), 0));
  const result: RowLoad[] = [];
  for (const hand of [0, 1]) {
    for (let rowIdx = 1; rowIdx <= 6; rowIdx += 1) {
      const presses = counts.get(`${hand}:${rowIdx}`) ?? 0;
      result.push({
        hand: hand === 0 ? "L" : "R",
        rowIdx,
        presses,
        share: safeDivide(presses, total),
        handShare: safeDivide(presses, handTotals[hand] ?? 0),
      });
    }
  }
  return result;
}

function getPositionRows(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): PositionRow[] {
  const filter = timestampFilter("kw.start_ts", range, hour, profile, device);
  return database.query(`
    SELECT pc.pos, SUM(pc.presses) AS presses
    FROM pos_count pc JOIN key_window kw ON kw.id = pc.window_id
    WHERE ${filter.sql}
    GROUP BY pc.pos
  `).all(...filter.params) as PositionRow[];
}

function positionalContext(rows: PositionRow[]): PositionalContext {
  const tierBKeystrokes = rows.reduce((sum, row) => sum + Number(row.presses), 0);
  const unattributedPresses = Number(rows.find((row) => Number(row.pos) === -1)?.presses ?? 0);
  const unattributedShare = safeDivide(unattributedPresses, tierBKeystrokes);
  return {
    tierBKeystrokes,
    attributedPresses: tierBKeystrokes - unattributedPresses,
    unattributedPresses,
    unattributedShare,
    unreliable: unattributedShare > 0.25,
  };
}

function getModifierHolds(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): ModifierHoldMetric[] {
  const filter = timestampFilter("b.ts", range, hour, profile, device);
  const rows = database.query(`
    SELECT mh.mod_class AS subject, mh.dur_bucket AS bucket, SUM(mh.n) AS n
    FROM mod_hold_hist mh JOIN bucket b ON b.id = mh.bucket_id
    WHERE ${filter.sql}
    GROUP BY mh.mod_class, mh.dur_bucket
  `).all(...filter.params) as HistRow[];

  return MOD_CLASS_LABELS.map((label, modClass) => {
    const histogramMap = new Map<number, number>();
    for (const row of rows) {
      if (Number(row.subject) === modClass) histogramMap.set(Number(row.bucket), Number(row.n));
    }
    const histogram = DURATION_BUCKETS.map((bucket) => ({
      bucket,
      midpointMs: durationBucketMidpoint(bucket),
      count: histogramMap.get(bucket) ?? 0,
      openEnded: bucket === 21,
    }));
    const count = histogram.reduce((sum, bin) => sum + bin.count, 0);
    const totalMs = histogram.reduce((sum, bin) => sum + bin.midpointMs * bin.count, 0);
    const totalOpenEnded = (histogramMap.get(21) ?? 0) > 0;
    return {
      modClass,
      label,
      count,
      total: estimatedDuration(totalMs, totalOpenEnded),
      median: histogramPercentile(histogramMap, 0.5),
      p95: histogramPercentile(histogramMap, 0.95),
      histogram,
    };
  });
}

function getMisfires(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  totalKeystrokes: number,
  hour?: number,
): RangeMetrics["misfires"] {
  const filter = timestampFilter("b.ts", range, hour, profile, device);
  const rows = database.query(`
    SELECT ec.kind, ec.subject, SUM(ec.n) AS n
    FROM event_count ec JOIN bucket b ON b.id = ec.bucket_id
    WHERE ${filter.sql} AND ec.kind IN (0, 1, 2)
    GROUP BY ec.kind, ec.subject
  `).all(...filter.params) as EventRow[];
  const kinds = EVENT_KIND_LABELS.map((label, kind) => {
    const byModClass = MOD_CLASS_LABELS.map((modLabel, modClass) => {
      const count = Number(rows.find(
        (row) => Number(row.kind) === kind && Number(row.subject) === modClass,
      )?.n ?? 0);
      return { modClass, label: modLabel, count, per1000: safeDivide(count * 1_000, totalKeystrokes) };
    });
    const count = byModClass.reduce((sum, metric) => sum + metric.count, 0);
    return { kind, label, count, per1000: safeDivide(count * 1_000, totalKeystrokes), byModClass };
  });
  const lonelyCount = kinds[0]?.count ?? 0;
  return {
    targetPercent: 0.5,
    lonelyModTargetMet: totalKeystrokes === 0 || safeDivide(lonelyCount, totalKeystrokes) < 0.005,
    kinds,
  };
}

function getCorrectionTax(
  database: Database,
  meta: AnalysisMeta,
  range: TimeRange,
  positionRows: PositionRow[],
  positional: PositionalContext,
  totalKeystrokes: number,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): RangeMetrics["correctionTax"] {
  const counts = new Map(positionRows.map((row) => [Number(row.pos), Number(row.presses)]));
  const backspacePositions = meta.positions
    .filter((position) => position.baseKeycode === "KEY_BACKSPACE")
    .map((position) => position.pos);
  const positionalBackspacePresses = backspacePositions
    .reduce((sum, pos) => sum + (counts.get(pos) ?? 0), 0);

  const filter = timestampFilter("b.ts", range, hour, profile, device);
  const rows = database.query(`
    SELECT ec.subject, SUM(ec.n) AS n
    FROM event_count ec JOIN bucket b ON b.id = ec.bucket_id
    WHERE ${filter.sql} AND ec.kind = 3
    GROUP BY ec.subject
  `).all(...filter.params) as Array<{ subject: number; n: number }>;
  const midpoint = [1, 2, 3, 4, 6.5, 12.5, 17];
  const runHistogram = midpoint.map((value, bucket) => ({
    bucket,
    midpoint: value,
    count: Number(rows.find((row) => Number(row.subject) === bucket)?.n ?? 0),
    openEnded: bucket === 6,
  }));
  const burstEstimatedBackspacePresses = runHistogram
    .reduce((sum, entry) => sum + entry.midpoint * entry.count, 0);
  return {
    positionalBackspacePresses,
    positionalShare: safeDivide(positionalBackspacePresses, positional.tierBKeystrokes),
    burstEstimatedBackspacePresses,
    burstShare: safeDivide(burstEstimatedBackspacePresses, totalKeystrokes),
    burstEstimateOpenEnded: (runHistogram[6]?.count ?? 0) > 0,
    runHistogram,
    positional,
    context: getCorrectionContext(database, meta, range, profile, device, hour),
  };
}

/**
 * Keys whose base binding is a character but whose keycode name is not. Everything else falls back
 * to the keycode name in angle brackets, which is never mistaken for a character the user typed.
 */
const KEYCODE_CHARACTERS: Record<string, string> = {
  KEY_GRAVE: "`", KEY_MINUS: "-", KEY_EQUAL: "=",
  KEY_LEFTBRACE: "[", KEY_RIGHTBRACE: "]", KEY_BACKSLASH: "\\",
  KEY_SEMICOLON: ";", KEY_APOSTROPHE: "'",
  KEY_COMMA: ",", KEY_DOT: ".", KEY_SLASH: "/",
  KEY_SPACE: "␣", KEY_TAB: "⇥", KEY_ENTER: "⏎",
  KEY_BACKSPACE: "⌫", KEY_DELETE: "⌦", KEY_ESC: "⎋",
};

function renderKeycode(keycode: string): string {
  const glyph = KEYCODE_CHARACTERS[keycode];
  if (glyph !== undefined) return glyph;
  const name = keycode.startsWith("KEY_") ? keycode.slice(4) : keycode;
  return /^[A-Z0-9]$/.test(name) ? name.toLowerCase() : `<${name.toLowerCase()}>`;
}

/**
 * A position renders to whatever its base layer binds, never to a guess. `-1` is a key the daemon
 * could not attribute to a base-layer position, `-2` is a slot that held no key at all, and a
 * position with no base binding is as unknown as `-1` — all three would be lies if rendered as text.
 */
function renderPosition(meta: AnalysisMeta, pos: number): string {
  if (pos === POSITION_ABSENT) return "·";
  if (pos === POSITION_UNATTRIBUTED) return "?";
  const keycode = meta.position(pos)?.baseKeycode;
  return keycode ? renderKeycode(keycode) : "?";
}

function renderFinger(finger: number): string {
  return finger === FINGER_ABSENT ? "·" : FINGER_LABELS[finger] ?? "·";
}

function latencyClass(bucket: number): LatencyClass {
  return LATENCY_CLASS_LABELS[bucket] ?? "edit";
}

function runLabel(bucket: number): string {
  return RUN_BUCKET_LABELS[bucket] ?? String(bucket);
}

function modLabels(mask: number): string[] {
  return MOD_CLASS_LABELS.filter((_, modClass) => (mask & (1 << modClass)) !== 0);
}

function emptyCorrectedPosition(pos: number): CorrectedPosition {
  return { pos, corrections: 0, byLatency: { fumble: 0, ambiguous: 0, edit: 0 } };
}

/**
 * Tier C: the ordered trigrams that preceded a correction, summed across every window in range.
 *
 * Windows are independent samples of the same behaviour, so their counts add; averaging them would
 * weight a short window as heavily as a long one. The degraded and dropped totals travel with the
 * result because a correction table that hides them reads as full coverage of the corrections made.
 */
export function getCorrectionContext(
  database: Database,
  meta: AnalysisMeta,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): CorrectionContext {
  // Runs before the n-gram reads: an ordered trigram means nothing once two keyboards' geometries
  // are summed into it, so a pooled read has to fail rather than answer.
  assertSinglePositionSpace(database, device, profile, range, "Tier C");

  const filter = timestampFilter("nw.start_ts", range, hour, profile, device);
  const totals = database.query(`
    SELECT COUNT(*) AS windows,
           COALESCE(SUM(nw.corrections), 0) AS corrections,
           COALESCE(SUM(nw.degraded), 0) AS degraded,
           COALESCE(SUM(nw.dropped), 0) AS dropped
    FROM ngram_window nw WHERE ${filter.sql}
  `).get(...filter.params) as NgramWindowRow;

  const ngramRows = database.query(`
    SELECT g.pos_a AS a, g.pos_b AS b, g.pos_c AS c,
           g.mod_mask, g.latency_bucket, g.run_bucket, SUM(g.n) AS n
    FROM ngram g JOIN ngram_window nw ON nw.id = g.window_id
    WHERE ${filter.sql}
    GROUP BY g.pos_a, g.pos_b, g.pos_c, g.mod_mask, g.latency_bucket, g.run_bucket
    ORDER BY n DESC, g.pos_a, g.pos_b, g.pos_c, g.mod_mask, g.latency_bucket, g.run_bucket
  `).all(...filter.params) as NgramRow[];

  const fingerRows = database.query(`
    SELECT g.finger_a AS a, g.finger_b AS b, g.finger_c AS c,
           g.mod_mask, g.latency_bucket, g.run_bucket, SUM(g.n) AS n
    FROM ngram_finger g JOIN ngram_window nw ON nw.id = g.window_id
    WHERE ${filter.sql}
    GROUP BY g.finger_a, g.finger_b, g.finger_c, g.mod_mask, g.latency_bucket, g.run_bucket
    ORDER BY n DESC, g.finger_a, g.finger_b, g.finger_c, g.mod_mask, g.latency_bucket, g.run_bucket
  `).all(...filter.params) as NgramRow[];

  const byLatency: Record<LatencyClass, number> = { fumble: 0, ambiguous: 0, edit: 0 };
  for (const row of [...ngramRows, ...fingerRows]) {
    byLatency[latencyClass(Number(row.latency_bucket))] += Number(row.n);
  }

  // The `pos_c` marginal, taken over every row rather than the truncated `topNgrams`: a per-key
  // total assembled from the top 20 rows would quietly omit the long tail it is meant to sum.
  const marginal = new Map<number, CorrectedPosition>();
  for (const row of ngramRows) {
    const pos = Number(row.c);
    const entry = marginal.get(pos) ?? emptyCorrectedPosition(pos);
    entry.corrections += Number(row.n);
    entry.byLatency[latencyClass(Number(row.latency_bucket))] += Number(row.n);
    marginal.set(pos, entry);
  }

  const corrections = Number(totals.corrections ?? 0);
  const degraded = Number(totals.degraded ?? 0);
  const dropped = Number(totals.dropped ?? 0);
  return {
    windowCount: Number(totals.windows),
    corrections,
    degraded,
    dropped,
    degradedShare: safeDivide(degraded, corrections),
    droppedShare: safeDivide(dropped, corrections),
    distinctNgrams: ngramRows.length,
    distinctFingerNgrams: fingerRows.length,
    topNgrams: ngramRows.slice(0, TOP_NGRAM_LIMIT).map((row) => {
      const positions: [number, number, number] = [Number(row.a), Number(row.b), Number(row.c)];
      return {
        positions,
        characters: positions.map((pos) => renderPosition(meta, pos)).join(" "),
        count: Number(row.n),
        latencyBucket: Number(row.latency_bucket),
        latencyClass: latencyClass(Number(row.latency_bucket)),
        runBucket: Number(row.run_bucket),
        runLabel: runLabel(Number(row.run_bucket)),
        modMask: Number(row.mod_mask),
        modLabels: modLabels(Number(row.mod_mask)),
      };
    }),
    byFinger: fingerRows.slice(0, TOP_NGRAM_LIMIT).map((row) => {
      const fingers: [number, number, number] = [Number(row.a), Number(row.b), Number(row.c)];
      return {
        fingers,
        labels: fingers.map(renderFinger).join(" "),
        count: Number(row.n),
        latencyBucket: Number(row.latency_bucket),
        latencyClass: latencyClass(Number(row.latency_bucket)),
        runBucket: Number(row.run_bucket),
        runLabel: runLabel(Number(row.run_bucket)),
        modMask: Number(row.mod_mask),
        modLabels: modLabels(Number(row.mod_mask)),
      };
    }),
    byLatency,
    byPosition: [...marginal.values()]
      .filter((entry) => entry.pos !== POSITION_UNATTRIBUTED && entry.pos !== POSITION_ABSENT)
      .sort((left, right) => right.corrections - left.corrections || left.pos - right.pos),
    withoutPosition: {
      unattributed: marginal.get(POSITION_UNATTRIBUTED)
        ?? emptyCorrectedPosition(POSITION_UNATTRIBUTED),
      absent: marginal.get(POSITION_ABSENT) ?? emptyCorrectedPosition(POSITION_ABSENT),
    },
  };
}

function getDailyDose(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  hour?: number,
): RangeMetrics["dailyDose"] {
  const filter = timestampFilter("b.ts", range, hour, profile, device);
  const dayRows = database.query(`
    SELECT strftime('%Y-%m-%d', b.ts, 'unixepoch', 'localtime') AS date,
           SUM(b.keystrokes) AS keystrokes
    FROM bucket b WHERE ${filter.sql}
    GROUP BY date ORDER BY date
  `).all(...filter.params) as DayRow[];
  const holdRows = database.query(`
    SELECT strftime('%Y-%m-%d', b.ts, 'unixepoch', 'localtime') AS date,
           h.dur_bucket AS bucket, SUM(h.n) AS n
    FROM hold_hist h JOIN bucket b ON b.id = h.bucket_id
    WHERE ${filter.sql}
    GROUP BY date, h.dur_bucket
  `).all(...filter.params) as DayHistRow[];
  const modRows = database.query(`
    SELECT strftime('%Y-%m-%d', b.ts, 'unixepoch', 'localtime') AS date,
           h.dur_bucket AS bucket, SUM(h.n) AS n
    FROM mod_hold_hist h JOIN bucket b ON b.id = h.bucket_id
    WHERE ${filter.sql}
    GROUP BY date, h.dur_bucket
  `).all(...filter.params) as DayHistRow[];
  const holdMsByDay = new Map<string, number>();
  for (const row of [...holdRows, ...modRows]) {
    holdMsByDay.set(
      row.date,
      (holdMsByDay.get(row.date) ?? 0) + durationBucketMidpoint(Number(row.bucket)) * Number(row.n),
    );
  }
  const days = dayRows.map((row) => ({
    date: row.date,
    keystrokes: Number(row.keystrokes),
    holdHours: (holdMsByDay.get(row.date) ?? 0) / 3_600_000,
  }));
  const dayCount = days.length;
  return {
    days,
    dayCount,
    keystrokesPerDay: safeDivide(days.reduce((sum, day) => sum + day.keystrokes, 0), dayCount),
    holdHoursPerDay: safeDivide(days.reduce((sum, day) => sum + day.holdHours, 0), dayCount),
  };
}

function toPositionLoad(
  metaPositions: readonly PositionMeta[],
  rows: PositionRow[],
): PositionLoad[] {
  const counts = new Map(rows.map((row) => [Number(row.pos), Number(row.presses)]));
  return metaPositions.map((position) => ({
    pos: position.pos,
    hand: position.hand,
    row: position.row,
    col: position.col,
    finger: position.finger,
    baseKeycode: position.baseKeycode,
    presses: counts.get(position.pos) ?? 0,
  }));
}

function computeRangeMetrics(
  database: Database,
  meta: AnalysisMeta,
  range: TimeRange,
  profile: ProfileScope,
  device: DeviceScope,
  positionSpace: string | null,
  hour?: number,
): RangeMetrics {
  const totals = getTotals(database, range, profile, device, hour);
  const totalKeystrokes = Number(totals.total ?? 0);
  const positionRows = getPositionRows(database, range, profile, device, hour);
  const positional = positionalContext(positionRows);
  const positionLoad = toPositionLoad(meta.positions, positionRows);
  const outerByHand = (["L", "R"] as const).map((hand) => {
    const handPositions = positionLoad.filter((position) => position.hand === hand);
    const attributedHandPresses = handPositions.reduce((sum, position) => sum + position.presses, 0);
    const presses = handPositions
      .filter((position) => position.row >= 1 && position.row <= 3
        && position.col !== null && position.col >= 4 && position.col <= 6)
      .reduce((sum, position) => sum + position.presses, 0);
    return { hand, presses, attributedHandPresses, share: safeDivide(presses, attributedHandPresses) };
  });

  return {
    range,
    header: {
      profile: profile.label,
      device: device.label,
      positionSpace,
      totalKeystrokes,
      autorepeats: Number(totals.autorepeats ?? 0),
      bucketCount: Number(totals.count),
      tierBWindowCount: getTierBWindowCount(database, range, profile, device, hour),
      altHandAmbiguous: meta.altHandAmbiguous,
      noData: Number(totals.count) === 0 && positional.tierBKeystrokes === 0,
    },
    perFinger: getFingerLoad(database, range, profile, device, hour),
    perRow: getRowLoad(database, range, profile, device, hour),
    outerUpperQuadrant: {
      source: "Tier B",
      excludesUnattributed: true,
      byHand: outerByHand,
      positional,
    },
    modifierHolds: getModifierHolds(database, range, profile, device, hour),
    misfires: getMisfires(database, range, profile, device, totalKeystrokes, hour),
    correctionTax: getCorrectionTax(
      database, meta, range, positionRows, positional, totalKeystrokes, profile, device, hour,
    ),
    dailyDose: getDailyDose(database, range, profile, device, hour),
    positionLoad,
  };
}

export function calculateMetrics(
  database: Database,
  meta: AnalysisMeta,
  range: TimeRange,
  options: MetricsOptions = {},
): AnalysisMetrics {
  const readSnapshot = (): AnalysisMetrics => {
    const profile = resolveProfileScope(database, options.profile);
    const device = resolveDeviceScope(database, options.device);
    // Runs before any positional query: a request that spans two position spaces must fail loudly
    // rather than return a pooled heatmap that means nothing.
    const positionSpace = assertSinglePositionSpace(database, device, profile, range);
    const metrics = computeRangeMetrics(database, meta, range, profile, device, positionSpace);
    return {
      ...metrics,
      fatigueDrift: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        metrics: computeRangeMetrics(database, meta, range, profile, device, positionSpace, hour),
      })),
    };
  };
  return database.inTransaction
    ? readSnapshot()
    : database.transaction(readSnapshot).deferred();
}
