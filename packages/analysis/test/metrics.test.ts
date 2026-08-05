import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openKeylabDatabase } from "../src/db";
import { loadAnalysisMeta } from "../src/meta";
import {
  calculateMetrics,
  histogramPercentile,
  parseSince,
} from "../src/metrics";
import { renderReport } from "../src/report";
import { createFixture, createProfileFixture, FIXTURE_NOW, type SeededFixture } from "./fixture";

const fixtures: SeededFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function seededMetrics(options: { empty?: boolean; future?: boolean; since?: "7d" | "all" } = {}) {
  const fixtureOptions: { empty?: boolean; future?: boolean } = {};
  if (options.empty !== undefined) fixtureOptions.empty = options.empty;
  if (options.future !== undefined) fixtureOptions.future = options.future;
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

  test("unattributed share is correct and the over-25% warning is loud", () => {
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
          profile: "default", totalKeystrokes: 100, autorepeats: 5, bucketCount: 1,
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

describe("database opener", () => {
  test("rejects a future schema_version clearly", () => {
    const fixture = createFixture({ schemaVersion: 3 });
    fixtures.push(fixture);
    expect(() => openKeylabDatabase(fixture.path)).toThrow("schema_version \"3\"; expected 2");
  });

  test("points an unmigrated v1 database at the daemon", () => {
    const fixture = createFixture({ schemaVersion: 1 });
    fixtures.push(fixture);
    expect(() => openKeylabDatabase(fixture.path)).toThrow("the daemon migrates v1 in place");
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
