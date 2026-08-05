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

export interface MetricsOptions {
  profile?: string;
}

/** `null` means "no profile clause at all", which is how pooling is expressed. */
interface ProfileScope {
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

export interface RangeMetrics {
  range: TimeRange;
  header: {
    profile: string;
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

/**
 * The profile clause rides along with the time clause because every scoped query already joins the
 * table that carries `profile_id`. Deriving the alias from the timestamp column keeps the two from
 * ever being applied to different tables.
 */
function timestampFilter(
  column: string,
  range: TimeRange,
  hour: number | undefined,
  profile: ProfileScope,
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
  if (profile.id !== null) {
    const alias = column.split(".")[0];
    clauses.push(`${alias}.profile_id = ?`);
    params.push(profile.id);
  }
  return { sql: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "), params };
}

function getTotals(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  hour?: number,
): TotalsRow {
  const filter = timestampFilter("b.id", range, hour, profile);
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
  hour?: number,
): number {
  const filter = timestampFilter("kw.start_ts", range, hour, profile);
  const row = database.query(`
    SELECT COUNT(*) AS value FROM key_window kw WHERE ${filter.sql}
  `).get(...filter.params) as ScalarRow;
  return Number(row.value ?? 0);
}

function getFingerLoad(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  hour?: number,
): FingerLoad[] {
  const filter = timestampFilter("b.id", range, hour, profile);
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
  hour?: number,
): RowLoad[] {
  const filter = timestampFilter("b.id", range, hour, profile);
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
  hour?: number,
): PositionRow[] {
  const filter = timestampFilter("kw.start_ts", range, hour, profile);
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
  hour?: number,
): ModifierHoldMetric[] {
  const filter = timestampFilter("b.id", range, hour, profile);
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
  totalKeystrokes: number,
  hour?: number,
): RangeMetrics["misfires"] {
  const filter = timestampFilter("b.id", range, hour, profile);
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
  hour?: number,
): RangeMetrics["correctionTax"] {
  const counts = new Map(positionRows.map((row) => [Number(row.pos), Number(row.presses)]));
  const backspacePositions = meta.positions
    .filter((position) => position.baseKeycode === "KEY_BACKSPACE")
    .map((position) => position.pos);
  const positionalBackspacePresses = backspacePositions
    .reduce((sum, pos) => sum + (counts.get(pos) ?? 0), 0);

  const filter = timestampFilter("b.id", range, hour, profile);
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
  };
}

function getDailyDose(
  database: Database,
  range: TimeRange,
  profile: ProfileScope,
  hour?: number,
): RangeMetrics["dailyDose"] {
  const filter = timestampFilter("b.id", range, hour, profile);
  const dayRows = database.query(`
    SELECT strftime('%Y-%m-%d', b.id, 'unixepoch', 'localtime') AS date,
           SUM(b.keystrokes) AS keystrokes
    FROM bucket b WHERE ${filter.sql}
    GROUP BY date ORDER BY date
  `).all(...filter.params) as DayRow[];
  const holdRows = database.query(`
    SELECT strftime('%Y-%m-%d', b.id, 'unixepoch', 'localtime') AS date,
           h.dur_bucket AS bucket, SUM(h.n) AS n
    FROM hold_hist h JOIN bucket b ON b.id = h.bucket_id
    WHERE ${filter.sql}
    GROUP BY date, h.dur_bucket
  `).all(...filter.params) as DayHistRow[];
  const modRows = database.query(`
    SELECT strftime('%Y-%m-%d', b.id, 'unixepoch', 'localtime') AS date,
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
  hour?: number,
): RangeMetrics {
  const totals = getTotals(database, range, profile, hour);
  const totalKeystrokes = Number(totals.total ?? 0);
  const positionRows = getPositionRows(database, range, profile, hour);
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
      totalKeystrokes,
      autorepeats: Number(totals.autorepeats ?? 0),
      bucketCount: Number(totals.count),
      tierBWindowCount: getTierBWindowCount(database, range, profile, hour),
      altHandAmbiguous: meta.altHandAmbiguous,
      noData: Number(totals.count) === 0 && positional.tierBKeystrokes === 0,
    },
    perFinger: getFingerLoad(database, range, profile, hour),
    perRow: getRowLoad(database, range, profile, hour),
    outerUpperQuadrant: {
      source: "Tier B",
      excludesUnattributed: true,
      byHand: outerByHand,
      positional,
    },
    modifierHolds: getModifierHolds(database, range, profile, hour),
    misfires: getMisfires(database, range, profile, totalKeystrokes, hour),
    correctionTax: getCorrectionTax(
      database, meta, range, positionRows, positional, totalKeystrokes, profile, hour,
    ),
    dailyDose: getDailyDose(database, range, profile, hour),
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
    const metrics = computeRangeMetrics(database, meta, range, profile);
    return {
      ...metrics,
      fatigueDrift: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        metrics: computeRangeMetrics(database, meta, range, profile, hour),
      })),
    };
  };
  return database.inTransaction
    ? readSnapshot()
    : database.transaction(readSnapshot).deferred();
}
