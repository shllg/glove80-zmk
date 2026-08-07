import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openKeylabDatabase } from "../src/db";
import { loadAnalysisMeta } from "../src/meta";
import {
  calculateMetrics,
  getCorrectionContext,
  histogramPercentile,
  parseSince,
  resolveDeviceScope,
  resolveProfileScope,
} from "../src/metrics";
import { renderReport } from "../src/report";
import {
  createFixture,
  createMultiDeviceFixture,
  createProfileFixture,
  FIXTURE_NOW,
  type SeededFixture,
} from "./fixture";

const fixtures: SeededFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function seededMetrics(
  options: { empty?: boolean; future?: boolean; since?: "7d" | "all"; layerCounts?: boolean } = {},
) {
  const fixtureOptions: { empty?: boolean; future?: boolean; layerCounts?: boolean } = {};
  if (options.empty !== undefined) fixtureOptions.empty = options.empty;
  if (options.future !== undefined) fixtureOptions.future = options.future;
  if (options.layerCounts !== undefined) fixtureOptions.layerCounts = options.layerCounts;
  const fixture = createFixture(fixtureOptions);
  fixtures.push(fixture);
  const database = openKeylabDatabase(fixture.path);
  const meta = loadAnalysisMeta(database, fixture.metaPath);
  const metrics = calculateMetrics(database, meta, parseSince(options.since ?? "7d", FIXTURE_NOW));
  return { fixture, database, metrics };
}

describe("analysis metrics", () => {
  test("snapshots each seeded metric against hand-computed values", () => {
    const { database, metrics } = seededMetrics();
    try {
      expect({
        header: metrics.header,
        perFinger: metrics.perFinger.map(({ label, presses, share }) => ({ label, presses, share })),
        perRow: metrics.perRow.filter((row) => row.presses > 0),
        layerUsage: metrics.layerUsage,
        outerUpperQuadrant: metrics.outerUpperQuadrant,
        modifierHolds: metrics.modifierHolds
          .filter((metric) => metric.count > 0)
          .map(({ label, count, total, median, p95 }) => ({ label, count, total, median, p95 })),
        misfires: {
          targetPercent: metrics.misfires.targetPercent,
          lonelyModTargetMet: metrics.misfires.lonelyModTargetMet,
          kinds: metrics.misfires.kinds.map((kind) => ({
            label: kind.label,
            count: kind.count,
            per1000: kind.per1000,
            nonzeroClasses: kind.byModClass.filter((item) => item.count > 0),
          })),
        },
        correctionTax: {
          positionalBackspacePresses: metrics.correctionTax.positionalBackspacePresses,
          positionalShare: metrics.correctionTax.positionalShare,
          burstEstimatedBackspacePresses: metrics.correctionTax.burstEstimatedBackspacePresses,
          burstShare: metrics.correctionTax.burstShare,
          burstEstimateOpenEnded: metrics.correctionTax.burstEstimateOpenEnded,
        },
        dailyDose: metrics.dailyDose,
      }).toEqual({
        header: {
          profile: "default",
          device: "* (all devices)",
          positionSpace: "glove80",
          totalKeystrokes: 100,
          autorepeats: 5,
          bucketCount: 1,
          tierBWindowCount: 1,
          altHandAmbiguous: true,
          noData: false,
        },
        perFinger: [
          { label: "L_index", presses: 30, share: 0.3 },
          { label: "L_middle", presses: 20, share: 0.2 },
          { label: "L_ring", presses: 0, share: 0 },
          { label: "L_pinky", presses: 0, share: 0 },
          { label: "L_thumb", presses: 0, share: 0 },
          { label: "R_index", presses: 25, share: 0.25 },
          { label: "R_middle", presses: 0, share: 0 },
          { label: "R_ring", presses: 0, share: 0 },
          { label: "R_pinky", presses: 0, share: 0 },
          { label: "R_thumb", presses: 25, share: 0.25 },
        ],
        perRow: [
          { hand: "L", rowIdx: 1, presses: 20, share: 0.2, handShare: 0.4 },
          { hand: "L", rowIdx: 2, presses: 30, share: 0.3, handShare: 0.6 },
          { hand: "R", rowIdx: 1, presses: 10, share: 0.1, handShare: 0.2 },
          { hand: "R", rowIdx: 3, presses: 40, share: 0.4, handShare: 0.8 },
        ],
        layerUsage: {
          presses: 100,
          byLayer: [
            { layerId: 0, name: "Base", presses: 80, share: 0.8 },
            { layerId: 5, name: "Navigation", presses: 20, share: 0.2 },
          ],
        },
        outerUpperQuadrant: {
          source: "Tier B",
          excludesUnattributed: true,
          byHand: [
            { hand: "L", presses: 12, attributedHandPresses: 12, share: 1 },
            { hand: "R", presses: 20, attributedHandPresses: 58, share: 20 / 58 },
          ],
          positional: {
            tierBKeystrokes: 100,
            attributedPresses: 70,
            unattributedPresses: 30,
            unattributedShare: 0.3,
            unreliable: true,
          },
        },
        modifierHolds: [
          {
            label: "L_CTRL", count: 4,
            total: { ms: 1087.5, openEnded: true, label: ">=1087.5 ms" },
            median: { ms: 37.5, openEnded: false, label: "~37.5 ms" },
            p95: { ms: 1000, openEnded: true, label: ">=1000 ms" },
          },
          {
            label: "R_ALT", count: 2,
            total: { ms: 1500, openEnded: false, label: "~1500 ms" },
            median: { ms: 750, openEnded: false, label: "~750 ms" },
            p95: { ms: 750, openEnded: false, label: "~750 ms" },
          },
        ],
        misfires: {
          targetPercent: 0.5,
          lonelyModTargetMet: false,
          kinds: [
            {
              label: "LONELY_MOD", count: 2, per1000: 20,
              nonzeroClasses: [{ modClass: 0, label: "L_CTRL", count: 2, per1000: 20 }],
            },
            {
              label: "MOD_DURING_ALPHA", count: 3, per1000: 30,
              nonzeroClasses: [{ modClass: 0, label: "L_CTRL", count: 3, per1000: 30 }],
            },
            {
              label: "BSP_BURST_AFTER_MOD", count: 1, per1000: 10,
              nonzeroClasses: [{ modClass: 0, label: "L_CTRL", count: 1, per1000: 10 }],
            },
          ],
        },
        correctionTax: {
          positionalBackspacePresses: 8,
          positionalShare: 0.08,
          burstEstimatedBackspacePresses: 25.5,
          burstShare: 0.255,
          burstEstimateOpenEnded: true,
        },
        dailyDose: {
          days: [{ date: "2023-11-14", keystrokes: 100, holdHours: 5212.5 / 3_600_000 }],
          dayCount: 1,
          keystrokesPerDay: 100,
          holdHoursPerDay: 5212.5 / 3_600_000,
        },
      });
    } finally {
      database.close();
    }
  });

  test("per-finger shares sum to one when data exists", () => {
    const { database, metrics } = seededMetrics();
    try {
      expect(metrics.perFinger.reduce((sum, finger) => sum + finger.share, 0)).toBeCloseTo(1, 12);
    } finally {
      database.close();
    }
  });

  test("histogram walking pins median, p95, and open-ended bucket 21", () => {
    const histogram = new Map([[0, 50], [20, 44], [21, 6]]);
    expect(histogramPercentile(histogram, 0.5)).toEqual({
      ms: 12.5, openEnded: false, label: "~12.5 ms",
    });
    expect(histogramPercentile(histogram, 0.95)).toEqual({
      ms: 1000, openEnded: true, label: ">=1000 ms",
    });
  });

  test("unattributed_share_counts_only_presses_with_no_position", () => {
    const { database, metrics } = seededMetrics();
    try {
      expect(metrics.outerUpperQuadrant.positional.unattributedShare).toBe(0.3);
      expect(metrics.outerUpperQuadrant.positional.unreliable).toBe(true);
      const report = renderReport(metrics);
      expect(report.match(/Unattributed: 30\.00%/g)?.length).toBe(2);
      expect(report).toContain("POSITIONAL METRICS ARE UNRELIABLE");
      expect(report).toContain("L: 12/12 attributed hand presses");
      expect(report).toContain("R: 20/58 attributed hand presses");
    } finally {
      database.close();
    }
  });

  test("the_layer_split_is_absent_rather_than_zero_before_the_boundary", () => {
    const { database, metrics } = seededMetrics({ layerCounts: false });
    try {
      expect(metrics.layerUsage).toBeNull();
      expect(renderReport(metrics)).toContain(
        "absent — no layer attribution was recorded in this range",
      );
    } finally {
      database.close();
    }
  });

  test("an empty database produces zeros and no throw", () => {
    const { database, metrics } = seededMetrics({ empty: true });
    try {
      expect(metrics.header.noData).toBe(true);
      expect(metrics.header.totalKeystrokes).toBe(0);
      expect(metrics.perFinger.every((finger) => finger.share === 0)).toBe(true);
      expect(metrics.modifierHolds.every((metric) => metric.total.ms === 0)).toBe(true);
      expect(() => renderReport(metrics)).not.toThrow();
      expect(renderReport(metrics)).toContain("NO DATA IN RANGE");
    } finally {
      database.close();
    }
  });

  test("range filtering excludes out-of-range Tier A buckets and Tier B windows", () => {
    const recent = seededMetrics();
    const all = seededMetrics({ since: "all" });
    try {
      expect(recent.metrics.header.totalKeystrokes).toBe(100);
      expect(recent.metrics.outerUpperQuadrant.positional.tierBKeystrokes).toBe(100);
      expect(all.metrics.header.totalKeystrokes).toBe(1_100);
      expect(all.metrics.outerUpperQuadrant.positional.tierBKeystrokes).toBe(1_100);
    } finally {
      recent.database.close();
      all.database.close();
    }
  });

  test("bounded ranges exclude future-dated Tier A buckets and Tier B windows", () => {
    const { database, metrics } = seededMetrics({ future: true });
    try {
      expect(metrics.header.totalKeystrokes).toBe(100);
      expect(metrics.header.bucketCount).toBe(1);
      expect(metrics.outerUpperQuadrant.positional.tierBKeystrokes).toBe(100);
      expect(metrics.header.tierBWindowCount).toBe(1);
    } finally {
      database.close();
    }
  });

  // Schema v5 demoted the seal second from `bucket.id` to `bucket.ts`, and the fixture's bucket ids
  // are now small surrogates. A read still filtering or grouping on `id` would compare a unix second
  // against 1 or 2 and silently return nothing, so these numbers are the v4 numbers or they are a
  // regression — there is no third outcome.
  test("analysis totals are unchanged by the column rename", () => {
    const recent = seededMetrics();
    const all = seededMetrics({ since: "all" });
    try {
      expect(recent.metrics.header.totalKeystrokes).toBe(100);
      expect(recent.metrics.header.autorepeats).toBe(5);
      expect(recent.metrics.header.bucketCount).toBe(1);
      expect(all.metrics.header.totalKeystrokes).toBe(1_100);
      expect(all.metrics.header.bucketCount).toBe(2);
      // Every family that joins `bucket`, not only the totals that read it directly.
      expect(recent.metrics.perFinger.reduce((sum, finger) => sum + finger.presses, 0)).toBe(100);
      expect(recent.metrics.perRow.reduce((sum, row) => sum + row.presses, 0)).toBe(100);
      expect(recent.metrics.modifierHolds.reduce((sum, hold) => sum + hold.count, 0)).toBe(6);
      expect(recent.metrics.misfires.kinds.reduce((sum, kind) => sum + kind.count, 0)).toBe(6);
    } finally {
      recent.database.close();
      all.database.close();
    }
  });

  test("the daily dose still groups by local day", () => {
    const all = seededMetrics({ since: "all" });
    try {
      // Two buckets eight days apart, each its own local day — a grouping that read the surrogate
      // id would collapse them into one nonsense date instead.
      expect(all.metrics.dailyDose.days).toEqual([
        { date: "2023-11-06", keystrokes: 1_000, holdHours: 0 },
        { date: "2023-11-14", keystrokes: 100, holdHours: 5_212.5 / 3_600_000 },
      ]);
      expect(all.metrics.dailyDose.dayCount).toBe(2);
      expect(all.metrics.dailyDose.keystrokesPerDay).toBe(550);
    } finally {
      all.database.close();
    }
  });

  test("snapshots every metric family in the active local-hour fatigue bucket", () => {
    const { fixture, database, metrics } = seededMetrics();
    try {
      const activeHours = metrics.fatigueDrift.filter(({ metrics: hourly }) => !hourly.header.noData);
      expect(activeHours).toHaveLength(1);
      const active = activeHours[0];
      if (!active) throw new Error("Expected one active fatigue hour");
      expect({
        hour: active.hour,
        header: active.metrics.header,
        perFinger: active.metrics.perFinger
          .filter((finger) => finger.presses > 0)
          .map(({ label, presses, share }) => ({ label, presses, share })),
        perRow: active.metrics.perRow.filter((row) => row.presses > 0),
        layerUsage: active.metrics.layerUsage,
        outerUpperQuadrant: active.metrics.outerUpperQuadrant,
        modifierHolds: active.metrics.modifierHolds
          .filter((metric) => metric.count > 0)
          .map(({ label, count, total, median, p95, histogram }) => ({
            label, count, total, median, p95,
            bins: histogram.filter((bin) => bin.count > 0),
          })),
        misfires: active.metrics.misfires.kinds.map(({ label, count, per1000 }) => ({
          label, count, per1000,
        })),
        correctionTax: {
          positionalBackspacePresses: active.metrics.correctionTax.positionalBackspacePresses,
          positionalShare: active.metrics.correctionTax.positionalShare,
          burstEstimatedBackspacePresses: active.metrics.correctionTax.burstEstimatedBackspacePresses,
          burstShare: active.metrics.correctionTax.burstShare,
          runBins: active.metrics.correctionTax.runHistogram.filter((bin) => bin.count > 0),
          positional: active.metrics.correctionTax.positional,
        },
        dailyDose: active.metrics.dailyDose,
        positionLoad: active.metrics.positionLoad
          .filter((position) => position.presses > 0)
          .map(({ pos, presses }) => ({ pos, presses })),
      }).toEqual({
        hour: 23,
        header: {
          profile: "default", device: "* (all devices)", positionSpace: "glove80",
          totalKeystrokes: 100, autorepeats: 5, bucketCount: 1,
          tierBWindowCount: 1, altHandAmbiguous: true, noData: false,
        },
        perFinger: [
          { label: "L_index", presses: 30, share: 0.3 },
          { label: "L_middle", presses: 20, share: 0.2 },
          { label: "R_index", presses: 25, share: 0.25 },
          { label: "R_thumb", presses: 25, share: 0.25 },
        ],
        perRow: [
          { hand: "L", rowIdx: 1, presses: 20, share: 0.2, handShare: 0.4 },
          { hand: "L", rowIdx: 2, presses: 30, share: 0.3, handShare: 0.6 },
          { hand: "R", rowIdx: 1, presses: 10, share: 0.1, handShare: 0.2 },
          { hand: "R", rowIdx: 3, presses: 40, share: 0.4, handShare: 0.8 },
        ],
        layerUsage: {
          presses: 100,
          byLayer: [
            { layerId: 0, name: "Base", presses: 80, share: 0.8 },
            { layerId: 5, name: "Navigation", presses: 20, share: 0.2 },
          ],
        },
        outerUpperQuadrant: {
          source: "Tier B", excludesUnattributed: true,
          byHand: [
            { hand: "L", presses: 12, attributedHandPresses: 12, share: 1 },
            { hand: "R", presses: 20, attributedHandPresses: 58, share: 20 / 58 },
          ],
          positional: {
            tierBKeystrokes: 100, attributedPresses: 70, unattributedPresses: 30,
            unattributedShare: 0.3, unreliable: true,
          },
        },
        modifierHolds: [
          {
            label: "L_CTRL", count: 4,
            total: { ms: 1087.5, openEnded: true, label: ">=1087.5 ms" },
            median: { ms: 37.5, openEnded: false, label: "~37.5 ms" },
            p95: { ms: 1000, openEnded: true, label: ">=1000 ms" },
            bins: [
              { bucket: 0, midpointMs: 12.5, count: 1, openEnded: false },
              { bucket: 1, midpointMs: 37.5, count: 2, openEnded: false },
              { bucket: 21, midpointMs: 1000, count: 1, openEnded: true },
            ],
          },
          {
            label: "R_ALT", count: 2,
            total: { ms: 1500, openEnded: false, label: "~1500 ms" },
            median: { ms: 750, openEnded: false, label: "~750 ms" },
            p95: { ms: 750, openEnded: false, label: "~750 ms" },
            bins: [{ bucket: 20, midpointMs: 750, count: 2, openEnded: false }],
          },
        ],
        misfires: [
          { label: "LONELY_MOD", count: 2, per1000: 20 },
          { label: "MOD_DURING_ALPHA", count: 3, per1000: 30 },
          { label: "BSP_BURST_AFTER_MOD", count: 1, per1000: 10 },
        ],
        correctionTax: {
          positionalBackspacePresses: 8,
          positionalShare: 0.08,
          burstEstimatedBackspacePresses: 25.5,
          burstShare: 0.255,
          runBins: [
            { bucket: 0, midpoint: 1, count: 2, openEnded: false },
            { bucket: 4, midpoint: 6.5, count: 1, openEnded: false },
            { bucket: 6, midpoint: 17, count: 1, openEnded: true },
          ],
          positional: {
            tierBKeystrokes: 100, attributedPresses: 70, unattributedPresses: 30,
            unattributedShare: 0.3, unreliable: true,
          },
        },
        dailyDose: {
          days: [{ date: "2023-11-14", keystrokes: 100, holdHours: 5212.5 / 3_600_000 }],
          dayCount: 1, keystrokesPerDay: 100, holdHoursPerDay: 5212.5 / 3_600_000,
        },
        positionLoad: [
          { pos: 0, presses: 12 },
          { pos: 9, presses: 20 },
          { pos: 40, presses: 30 },
          { pos: 56, presses: 8 },
        ],
      });
    } finally {
      database.close();
    }
  });
});

describe("Tier C correction context", () => {
  test("sums n-gram counts across windows instead of averaging them", () => {
    const { database, metrics } = seededMetrics();
    try {
      const context = metrics.correctionTax.context;
      expect(context.windowCount).toBe(2);
      expect(context.corrections).toBe(500);
      expect(context.distinctNgrams).toBe(5);
      // "t h e" at latency 0, run 0 appears in both windows: 120 + 80, not their mean.
      const top = context.topNgrams[0];
      expect(top).toBeDefined();
      expect(top?.characters).toBe("t h e");
      expect(top?.count).toBe(200);
      expect(top?.latencyClass).toBe("fumble");
      expect(top?.runLabel).toBe("1");
      expect(top?.modLabels).toEqual([]);
      expect(context.topNgrams.map((entry) => entry.count)).toEqual([200, 100, 60, 40, 30]);
      // Every counted correction is accounted for exactly once.
      const positional = context.topNgrams.reduce((sum, entry) => sum + entry.count, 0);
      const degraded = context.byFinger.reduce((sum, entry) => sum + entry.count, 0);
      expect(positional + degraded + context.dropped).toBe(context.corrections);
    } finally {
      database.close();
    }
  });

  test("marginalises pos_c over every row rather than over the rows it displays", () => {
    const { database, metrics } = seededMetrics();
    try {
      const context = metrics.correctionTax.context;
      const keycode = (pos: number) =>
        metrics.positionLoad.find((position) => position.pos === pos)?.baseKeycode;
      // "t h e" in both windows, "t h e" again at a second latency, the sentinel trigram and
      // "q w e" all end on E; only "a s d" ends anywhere else.
      expect(context.byPosition.map((entry) => [keycode(entry.pos), entry.corrections]))
        .toEqual([["KEY_E", 370], ["KEY_D", 60]]);
      expect(context.byPosition[0]?.byLatency).toEqual({ fumble: 230, ambiguous: 0, edit: 140 });
      // Every correction that kept a position is in the marginal exactly once, so it reconciles
      // against the window totals rather than against the truncated display list.
      const marginal = context.byPosition.reduce((sum, entry) => sum + entry.corrections, 0)
        + context.withoutPosition.unattributed.corrections
        + context.withoutPosition.absent.corrections;
      expect(marginal).toBe(context.corrections - context.degraded - context.dropped);
    } finally {
      database.close();
    }
  });

  test("renders unattributed and absent positions distinctly", () => {
    const { database, metrics } = seededMetrics();
    try {
      const sentinel = metrics.correctionTax.context.topNgrams
        .find((entry) => entry.count === 30);
      expect(sentinel).toBeDefined();
      expect(sentinel?.positions).toEqual([-2, -1, expect.any(Number)]);
      // "·" is a slot that held no key, "?" is a key with no resolved position. Never the same.
      expect(sentinel?.characters).toBe("· ? e");

      const degraded = metrics.correctionTax.context.byFinger
        .find((entry) => entry.count === 10);
      expect(degraded?.fingers).toEqual([3, -1, 3]);
      expect(degraded?.labels).toBe("L_pinky · L_pinky");
    } finally {
      database.close();
    }
  });

  test("splits corrections into fumbles, ambiguous cases and edits", () => {
    const { database, metrics } = seededMetrics();
    try {
      const context = metrics.correctionTax.context;
      expect(context.byLatency).toEqual({ fumble: 270, ambiguous: 70, edit: 140 });
      // Everything that kept a latency bucket, positional or degraded, is classified.
      const classified = context.byLatency.fumble + context.byLatency.ambiguous
        + context.byLatency.edit;
      expect(classified).toBe(context.corrections - context.dropped);

      const shifted = context.topNgrams.find((entry) => entry.modMask === 8);
      expect(shifted?.characters).toBe("a s d");
      expect(shifted?.latencyClass).toBe("ambiguous");
      expect(shifted?.runLabel).toBe("3");
      expect(shifted?.modLabels).toEqual(["L_SHIFT"]);
    } finally {
      database.close();
    }
  });

  test("reports the degraded and dropped shares rather than hiding them", () => {
    const { database, metrics } = seededMetrics();
    try {
      const context = metrics.correctionTax.context;
      expect(context.degraded).toBe(50);
      expect(context.dropped).toBe(20);
      expect(context.degradedShare).toBe(0.1);
      expect(context.droppedShare).toBe(0.04);
      expect(context.distinctFingerNgrams).toBe(2);
      expect(context.byFinger[0]).toMatchObject({
        fingers: [0, 1, 5],
        labels: "L_index L_middle R_index",
        count: 40,
        latencyClass: "fumble",
      });
    } finally {
      database.close();
    }
  });

  test("an empty Tier C produces zeroes, not a crash", () => {
    const { database, metrics } = seededMetrics({ empty: true });
    try {
      expect(metrics.correctionTax.context).toEqual({
        windowCount: 0,
        corrections: 0,
        degraded: 0,
        dropped: 0,
        degradedShare: 0,
        droppedShare: 0,
        distinctNgrams: 0,
        distinctFingerNgrams: 0,
        topNgrams: [],
        byFinger: [],
        byLatency: { fumble: 0, ambiguous: 0, edit: 0 },
        byPosition: [],
        withoutPosition: {
          unattributed: { pos: -1, corrections: 0, byLatency: { fumble: 0, ambiguous: 0, edit: 0 } },
          absent: { pos: -2, corrections: 0, byLatency: { fumble: 0, ambiguous: 0, edit: 0 } },
        },
      });
      expect(() => renderReport(metrics)).not.toThrow();
    } finally {
      database.close();
    }
  });

  test("prints a correction-context section", () => {
    const { database, metrics } = seededMetrics();
    try {
      const report = renderReport(metrics);
      expect(report).toContain("Correction context (Tier C; 2 windows, 500 corrections)");
      expect(report).toContain("fumble 270 (54.00%)");
      expect(report).toContain("ambiguous 70 (14.00%)");
      expect(report).toContain("edit 140 (28.00%)");
      expect(report).toContain("Degraded to finger level: 50 (10.00%)");
      expect(report).toContain("Dropped entirely: 20 (4.00%)");
      expect(report).toContain("Top trigrams (5 of 5 distinct)");
      expect(report).toContain("t h e");
      expect(report).toContain("· ? e");
      expect(report).toContain("L_SHIFT");
      expect(report).toContain("Finger transitions after degradation (2 of 2 distinct)");
      expect(report).toContain("L_index L_middle R_index");
      // The pre-Tier-C signals stay: they are all the older windows ever recorded.
      expect(report).toContain("Tier B position-derived backspaces: 8");
      expect(report).toContain("Tier A BSP_BURST estimate: >=25.5 presses");
    } finally {
      database.close();
    }
  });

  test("says so, and why, when no n-gram window exists", () => {
    const { database, metrics } = seededMetrics({ empty: true });
    try {
      const report = renderReport(metrics);
      expect(report).toContain("Correction context (Tier C): none in range.");
      expect(report).toContain("500 corrections");
      expect(report).toContain("ngram_capture is off");
      expect(report).toContain("It does not mean no corrections were made.");
    } finally {
      database.close();
    }
  });
});

describe("profile filtering", () => {
  function profileMetrics(options?: { profile?: string }) {
    const fixture = createProfileFixture();
    fixtures.push(fixture);
    const database = openKeylabDatabase(fixture.path);
    const meta = loadAnalysisMeta(database, fixture.metaPath);
    try {
      return calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), options);
    } finally {
      database.close();
    }
  }

  test("defaults to the default profile only", () => {
    expect(profileMetrics().header.totalKeystrokes).toBe(100);
  });

  test("selects a single named profile", () => {
    expect(profileMetrics({ profile: "gaming" }).header.totalKeystrokes).toBe(40);
  });

  test("pools every profile when asked", () => {
    expect(profileMetrics({ profile: "*" }).header.totalKeystrokes).toBe(140);
  });

  test("filters Tier B windows and positions too, not only Tier A", () => {
    const defaultProfile = profileMetrics();
    const gaming = profileMetrics({ profile: "gaming" });
    expect(defaultProfile.header.tierBWindowCount).toBe(1);
    expect(defaultProfile.outerUpperQuadrant.positional.tierBKeystrokes).toBe(100);
    expect(gaming.outerUpperQuadrant.positional.tierBKeystrokes).toBe(40);
    expect(profileMetrics({ profile: "*" }).header.tierBWindowCount).toBe(2);
  });

  test("names the active profile in the header so a filtered report is never mistaken", () => {
    expect(profileMetrics().header.profile).toBe("default");
    expect(profileMetrics({ profile: "gaming" }).header.profile).toBe("gaming");
    expect(profileMetrics({ profile: "*" }).header.profile).toBe("* (all profiles)");
  });

  test("rejects a profile that the database has never recorded", () => {
    const fixture = createProfileFixture();
    fixtures.push(fixture);
    const database = openKeylabDatabase(fixture.path);
    const meta = loadAnalysisMeta(database, fixture.metaPath);
    try {
      expect(() => calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), {
        profile: "training-de",
      })).toThrow("Unknown profile");
    } finally {
      database.close();
    }
  });

  test("the rendered report states the profile", () => {
    expect(renderReport(profileMetrics({ profile: "gaming" }))).toContain("Profile: gaming");
  });
});

describe("multi-device position spaces", () => {
  function multiDevice() {
    const fixture = createMultiDeviceFixture();
    fixtures.push(fixture);
    const database = openKeylabDatabase(fixture.path);
    const meta = loadAnalysisMeta(database, fixture.metaPath);
    return { database, meta };
  }

  test("refuses to pool Tier B across two position spaces", () => {
    const { database, meta } = multiDevice();
    try {
      expect(() => calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW)))
        .toThrow("Refusing to pool Tier B positional data across 2 position spaces");
      expect(() => calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), {
        device: "*",
      })).toThrow("glove80, qwerty-ansi");
    } finally {
      database.close();
    }
  });

  test("selecting one device makes the positional read legal and names its space", () => {
    const { database, meta } = multiDevice();
    try {
      const glove80 = calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), { device: 1 });
      expect(glove80.header.positionSpace).toBe("glove80");
      expect(glove80.header.totalKeystrokes).toBe(100);
      expect(glove80.outerUpperQuadrant.positional.tierBKeystrokes).toBe(100);

      const laptop = calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), { device: 2 });
      expect(laptop.header.positionSpace).toBe("qwerty-ansi");
      expect(laptop.header.totalKeystrokes).toBe(60);
      expect(laptop.outerUpperQuadrant.positional.tierBKeystrokes).toBe(60);
    } finally {
      database.close();
    }
  });

  test("Tier A pools across devices once the range holds no Tier B conflict", () => {
    const { database, meta } = multiDevice();
    try {
      // A range that excludes every Tier B window leaves Tier A free to pool both keyboards.
      const range = { label: "tier-a-only", sinceTs: null, nowTs: FIXTURE_NOW - 100 };
      const pooled = calculateMetrics(database, meta, range, { device: "*" });
      expect(pooled.header.positionSpace).toBeNull();
      expect(pooled.header.totalKeystrokes).toBe(0);

      const wide = calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), { device: 1 });
      expect(wide.perFinger[0]?.presses).toBe(100);
    } finally {
      database.close();
    }
  });

  test("refuses to pool n-grams across position spaces, and says Tier C when it does", () => {
    const { database, meta } = multiDevice();
    try {
      const range = parseSince("all", FIXTURE_NOW);
      const profile = resolveProfileScope(database, undefined);
      const pooled = resolveDeviceScope(database, "*");
      // Called directly, because through calculateMetrics the Tier B guard fires first — and an
      // operator reading the message has to learn which read actually refused.
      expect(() => getCorrectionContext(database, meta, range, profile, pooled))
        .toThrow("Refusing to pool Tier C correction-context n-grams across 2 position spaces");
      expect(() => getCorrectionContext(database, meta, range, profile, pooled))
        .toThrow("glove80, qwerty-ansi");
    } finally {
      database.close();
    }
  });

  test("a single-device n-gram read succeeds", () => {
    const { database, meta } = multiDevice();
    try {
      const range = parseSince("all", FIXTURE_NOW);
      const profile = resolveProfileScope(database, undefined);
      for (const id of [1, 2]) {
        const context = getCorrectionContext(
          database, meta, range, profile, resolveDeviceScope(database, id),
        );
        expect(context.windowCount).toBe(1);
        expect(context.corrections).toBe(500);
        expect(context.topNgrams[0]?.count).toBe(500);
      }
      expect(calculateMetrics(database, meta, range, { device: 1 }).correctionTax.context.corrections)
        .toBe(500);
    } finally {
      database.close();
    }
  });

  test("rejects a device id the database does not hold", () => {
    const { database, meta } = multiDevice();
    try {
      expect(() => calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW), { device: 99 }))
        .toThrow("Unknown device id 99");
    } finally {
      database.close();
    }
  });
});

describe("database opener", () => {
  test("rejects a future schema_version clearly", () => {
    const fixture = createFixture({ schemaVersion: 7 });
    fixtures.push(fixture);
    expect(() => openKeylabDatabase(fixture.path)).toThrow("schema_version \"7\"; expected 6");
  });

  test("rejects a v3 database with an actionable message", () => {
    const fixture = createFixture({ schemaVersion: 3 });
    fixtures.push(fixture);
    // v3 predates Tier C. The daemon's v3 -> v4 -> v5 -> v6 migration is the fix, and the message has to
    // say so.
    expect(() => openKeylabDatabase(fixture.path))
      .toThrow("Unsupported keylab schema_version \"3\"; expected 6");
    expect(() => openKeylabDatabase(fixture.path))
      .toThrow("Restart keylab.service once; the daemon migrates older schemas in place.");
  });

  test("points an unmigrated older database at the daemon", () => {
    for (const version of [1, 2, 3, 4, 5]) {
      const fixture = createFixture({ schemaVersion: version });
      fixtures.push(fixture);
      expect(() => openKeylabDatabase(fixture.path))
        .toThrow("the daemon migrates older schemas in place");
    }
  });

  test("really opens read-only", () => {
    const fixture = createFixture({ empty: true });
    fixtures.push(fixture);
    const database = openKeylabDatabase(fixture.path);
    try {
      expect(() => database.query("INSERT INTO meta(key, value) VALUES ('write', 'blocked')").run())
        .toThrow();
    } finally {
      database.close();
    }
  });

  test("metric reads reuse an existing caller transaction without nesting", () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const database = openKeylabDatabase(fixture.path);
    const meta = loadAnalysisMeta(database, fixture.metaPath);
    try {
      database.exec("BEGIN DEFERRED");
      expect(database.inTransaction).toBe(true);
      const metrics = calculateMetrics(database, meta, parseSince("7d", FIXTURE_NOW));
      expect(metrics.header.totalKeystrokes).toBe(100);
      expect(database.inTransaction).toBe(true);
      database.exec("ROLLBACK");
    } finally {
      if (database.inTransaction) database.exec("ROLLBACK");
      database.close();
    }
  });
});
