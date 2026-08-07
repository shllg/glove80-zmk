import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeylabDatabase } from "../../analysis/src/db";
import { loadAnalysisMeta } from "../../analysis/src/meta";
import {
  calculateMetrics,
  getCorrectionContext,
  parseLabRange,
  resolveDeviceScope,
  resolveProfileScope,
} from "../../analysis/src/metrics";
import {
  createCorrectionFixture,
  createFixture,
  createMultiDeviceFixture,
  createProfileFixture,
  FIXTURE_NOW,
  type SeededFixture,
} from "../../analysis/test/fixture";
import { toPhysicalRows } from "../../keymap/src/layout";
import {
  buildHeatmapGeometry,
  orderForPositionSpace,
  positionStructuredLayout,
} from "../src/geometry";
import { createRefreshScheduler } from "../public/refresh-scheduler.js";
import {
  applyStatus,
  correctionContextSummary,
  correctionFootnote,
  createControlTracker,
  createRouteTracker,
  fingerLabel,
  mechanicAvailable,
  misfireSummary,
  positionalSummary,
  PROFILE_CONFIRM_MS,
  rateLevel,
  recommendedDrill,
  trainingErrorIsTerminal,
} from "../public/view-model.js";
import {
  CORRECTION_PRESS_FLOOR,
  createLabServer,
  parseLabArgs,
  type LabApp,
} from "../src/server";
import { createTrainingManager } from "../src/training";

const fixtures: SeededFixture[] = [];
const apps: LabApp[] = [];
const temporaryDirectories: string[] = [];
const silentLogger = { log() {}, error() {} };

afterEach(() => {
  for (const app of apps.splice(0)) app.stop();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testOptions(
  fixture: SeededFixture,
  options: {
    pollIntervalMs?: number;
    keepaliveIntervalMs?: number;
    confirmProfileLease?: (leaseId: string, profile: string) => boolean | Promise<boolean>;
    now?: () => number;
  } = {},
) {
  return {
    dbPath: fixture.path,
    trainerPath: join(fixture.directory, "trainer.db"),
    metaPath: fixture.metaPath,
    host: "127.0.0.1" as const,
    port: 0,
    now: options.now ?? (() => FIXTURE_NOW),
    pollIntervalMs: options.pollIntervalMs ?? 20,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? 10_000,
    ...(options.confirmProfileLease ? { confirmProfileLease: options.confirmProfileLease } : {}),
    logger: silentLogger,
    serviceState: () => "active" as const,
    profiles: ["default", "training-de", "training-en", "gaming"],
    controlPath: join(fixture.directory, "control.json"),
  };
}

function startLab(options: {
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
  confirmProfileLease?: (leaseId: string, profile: string) => boolean | Promise<boolean>;
  now?: () => number;
} = {}) {
  const fixture = createFixture();
  fixtures.push(fixture);
  const app = createLabServer(testOptions(fixture, options));
  apps.push(app);
  return { fixture, app };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("lab analysis API", () => {
  test("summary returns the same analysis numbers for a seeded database", async () => {
    const { fixture, app } = startLab();
    const response = await fetch(`${app.url}/api/summary?range=7d`);
    expect(response.status).toBe(200);
    // The correction layer is Lab's own derivation; everything else must still be exactly what the
    // analysis package computed, with no Lab-side reinterpretation in between.
    const { correctionLayer, ...actual } = await response.json();
    expect(correctionLayer.pressFloor).toBe(CORRECTION_PRESS_FLOOR);

    const database = openKeylabDatabase(fixture.path);
    try {
      const meta = loadAnalysisMeta(database, fixture.metaPath);
      const expected = calculateMetrics(database, meta, parseLabRange("7d", FIXTURE_NOW), {
        profile: "*",
      });
      expect(actual).toEqual(expected);
    } finally {
      database.close();
    }
  });

  test("security headers are present on the page and API", async () => {
    const { app } = startLab();
    for (const path of ["/", "/api/summary?range=live"]) {
      const response = await fetch(`${app.url}${path}`);
      expect(response.headers.get("content-security-policy"))
        .toBe("default-src 'self'; connect-src 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("serves the browser module graph entirely from local assets", async () => {
    const { app } = startLab();
    const page = await fetch(`${app.url}/`);
    expect(await page.text()).toContain('<script src="/app.js" type="module"></script>');
    // Every module `app.js` imports has to be served from here, or the CSP blocks it at runtime and
    // nothing in this suite would have noticed.
    const script = await (await fetch(`${app.url}/app.js`)).text();
    const imported = [...script.matchAll(/from "(\/[\w.-]+\.js)"/g)].map((match) => match[1]);
    expect(imported.sort()).toEqual(["/refresh-scheduler.js", "/typing-session.js", "/view-model.js"]);
    for (const path of imported) {
      const module = await fetch(`${app.url}${path}`);
      expect(module.status).toBe(200);
      expect(module.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await module.text()).toContain("export function");
    }
  });

  test("every element id app.js queries exists in the page", () => {
    // Mechanical, and the only thing that catches an id drift: a `querySelector` that matches
    // nothing throws at the first render in the browser and in no test.
    const publicDirectory = join(import.meta.dir, "../public");
    const script = readFileSync(join(publicDirectory, "app.js"), "utf8");
    const page = readFileSync(join(publicDirectory, "index.html"), "utf8");
    const queried = [...script.matchAll(/byId\("([\w-]+)"\)/g)].map((match) => match[1]);
    const present = new Set([...page.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]));
    expect(queried.length).toBeGreaterThan(10);
    expect(queried.filter((id) => !present.has(id))).toEqual([]);
  });

  test("formats every report-only detail that the Insights renderer consumes", () => {
    const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
    for (const helper of [
      "fingerLabel", "misfireSummary", "positionalSummary", "correctionContextSummary",
    ]) expect(script).toContain(`${helper}(`);
    expect(fingerLabel({ label: "L_INDEX", share: 0.125 })).toBe("INDEX · 12.50%");
    expect(positionalSummary({
      unattributedShare: 0.3,
      unattributedPresses: 30,
      tierBKeystrokes: 100,
      unreliable: true,
    })).toBe("30.00% unattributed (30/100 Tier B keystrokes) · unreliable");
    expect(misfireSummary({
      kind: 0,
      count: 3,
      per1000: 1.25,
      byModClass: [{ label: "SHIFT", count: 2, per1000: 0.75 }],
    }, { targetPercent: 0.5, lonelyModTargetMet: false }))
      .toBe("1.25 / 1k · 3 · target <0.5%: above · SHIFT 0.75/1k (2)");
    expect(correctionContextSummary({
      windowCount: 2,
      corrections: 100,
      degraded: 30,
      degradedShare: 0.3,
      dropped: 5,
      droppedShare: 0.05,
      distinctNgrams: 17,
      distinctFingerNgrams: 9,
      topNgrams: [{}, {}],
      byFinger: [{}],
      byLatency: { fumble: 50, ambiguous: 25, edit: 20 },
    })).toEqual({
      headline: "2 windows · 100 corrections · degraded 30 (30.00%) · dropped 5 (5.00%)",
      latency: "fumble 50 (50.00%) · ambiguous 25 (25.00%) · edit 20 (20.00%)",
      top: "2 of 17 distinct trigrams shown",
      fingers: "1 of 9 distinct finger transitions shown",
    });
  });

  test("wires Train, History, recommendation, and keymap zoom state into the page", () => {
    const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
    const page = readFileSync(join(import.meta.dir, "../public/index.html"), "utf8");
    expect(script).toContain("rememberTrainFilters()");
    expect(script).toContain("restoreTrainFilters()");
    expect(script).toContain("rememberHistoryFilters()");
    expect(script).toContain("restoreHistoryFilters()");
    expect(script).toContain("restoreHistoryFilters();\n      rememberHistoryFilters();");
    expect(script.split("trainingErrorIsTerminal(error.code)")).toHaveLength(3);
    expect(script).toContain("} catch (error) {\n      if (trainingErrorIsTerminal(error.code))");
    expect(script).toContain("recommendedDrill(results[1].value)");
    expect(script).toContain("byId(\"keymap-image\").style.width");
    expect(page).toContain('id="overview-recommended"');
    expect(page).toContain('id="keymap-zoom"');
  });

  test("unknown routes return 404 without a stack trace", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/not-a-route`);
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toBe("Not found\n");
    expect(body).not.toContain("at ");
  });

  test("serves every application route directly", async () => {
    const { app } = startLab();
    for (const path of ["/", "/insights", "/train", "/history", "/keymap"]) {
      const response = await fetch(`${app.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<!doctype html>");
    }
  });

  test("starts and reports diagnostics when keylab.db is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glove80-lab-absent-"));
    temporaryDirectories.push(directory);
    const app = createLabServer({
      dbPath: join(directory, "missing.db"),
      trainerPath: join(directory, "trainer.db"),
      metaPath: join(import.meta.dir, "../../../out/keymap-meta.json"),
      repoRoot: join(import.meta.dir, "../../.."),
      host: "127.0.0.1",
      port: 0,
      logger: silentLogger,
      serviceState: () => "inactive",
    });
    apps.push(app);
    const health = await (await fetch(`${app.url}/api/health`)).json();
    expect(health).toMatchObject({
      service: "inactive",
      capture: "absent",
      database: { compatible: false },
    });
    expect((await fetch(`${app.url}/api/summary`)).status).toBe(503);
    expect((await fetch(`${app.url}/api/training/history`)).status).toBe(200);
    const training = await fetch(`${app.url}/api/training/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", language: "en", wordCount: 2 }),
    });
    expect(training.status).toBe(200);
    const started = await training.json();
    expect(started).toMatchObject({ captureMode: "trainer-only", keylabProfile: null });
    await fetch(`${app.url}/api/training/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: started.token }),
    });
  });

  test("keeps fixed benchmarks available when telemetry and keymap metadata are absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glove80-lab-no-inputs-"));
    temporaryDirectories.push(directory);
    const controlPath = join(directory, "control.json");
    writeFileSync(controlPath, JSON.stringify({
      paused: false,
      profile: "training-en",
      updated_at: FIXTURE_NOW,
      profile_lease: {
        id: "stale-while-daemon-is-down",
        restore_profile: "default",
        expires_at: FIXTURE_NOW + 60,
      },
    }));
    const app = createLabServer({
      dbPath: join(directory, "missing-keylab.db"),
      trainerPath: join(directory, "trainer.db"),
      metaPath: join(directory, "missing-keymap-meta.json"),
      repoRoot: directory,
      controlPath,
      host: "127.0.0.1",
      port: 0,
      now: () => FIXTURE_NOW,
      logger: silentLogger,
      serviceState: () => "inactive",
    });
    apps.push(app);

    const response = await fetch(`${app.url}/api/training/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", language: "de", wordCount: 2 }),
    });
    expect(response.status).toBe(200);
    const started = await response.json();
    expect(started).toMatchObject({
      mode: "benchmark",
      language: "de",
      captureMode: "trainer-only",
      keylabProfile: null,
    });
    expect(JSON.parse(readFileSync(controlPath, "utf8")))
      .toMatchObject({ profile_lease: { id: "stale-while-daemon-is-down" } });
    await fetch(`${app.url}/api/training/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: started.token }),
    });
    const mechanic = await fetch(`${app.url}/api/training/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "drill", family: "mechanic" }),
    });
    expect(mechanic.status).toBe(409);
    expect(await mechanic.json()).toMatchObject({ code: "capture-required" });
  });

  test("rejects a hostile Host header before routing", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/api/summary?range=all`, {
      headers: { Host: "attacker.example:4123" },
    });
    expect(response.status).toBe(421);
    expect(await response.text()).toBe("Misdirected request\n");
  });
});

describe("profile scope", () => {
  function startProfileLab() {
    const fixture = createProfileFixture();
    fixtures.push(fixture);
    const app = createLabServer(testOptions(fixture));
    apps.push(app);
    return { fixture, app };
  }

  const total = (summary: { header: { totalKeystrokes: number } }) => summary.header.totalKeystrokes;

  test("pools every profile unless one is named", async () => {
    const { app } = startProfileLab();
    // The analysis default is the `default` profile, which is right for a report that names its
    // scope and wrong here: a dashboard scoped to one profile drops everything typed under the
    // others while its totals still read as the whole picture.
    const pooled = await (await fetch(`${app.url}/api/summary?range=all`)).json();
    expect(total(pooled)).toBe(140);
    expect(pooled.header.profile).toBe("* (all profiles)");
  });

  test("scopes to one profile when asked, and says which", async () => {
    const { app } = startProfileLab();
    const gaming = await (await fetch(`${app.url}/api/summary?range=all&profile=gaming`)).json();
    expect(total(gaming)).toBe(40);
    expect(gaming.header.profile).toBe("gaming");

    const standard = await (await fetch(`${app.url}/api/summary?range=all&profile=default`)).json();
    expect(total(standard)).toBe(100);
    expect(total(standard) + total(gaming)).toBe(140);
  });
});

describe("multi-device Lab", () => {
  function startMultiDeviceLab() {
    const fixture = createMultiDeviceFixture();
    fixtures.push(fixture);
    const app = createLabServer(testOptions(fixture));
    apps.push(app);
    return { fixture, app };
  }

  test("lists every device that has data, with what tells two rows of one keyboard apart", async () => {
    const { app } = startMultiDeviceLab();
    const devices = await (await fetch(`${app.url}/api/devices`)).json();
    // Name and position space alone are identical for two rows of the same keyboard, which an
    // older daemon minted on every reconnect. The counts and first-seen time are what separate them.
    expect(devices).toEqual([
      {
        id: 1, name: "Evsieve Virtual Device", positionSpace: "glove80",
        firstTs: FIXTURE_NOW - 1_000_000, keystrokes: 100, tierBWindows: 1,
        keymapHash: "glove80-hash",
      },
      {
        id: 2, name: "AT Translated Set 2 keyboard", positionSpace: "qwerty-ansi",
        firstTs: FIXTURE_NOW - 1_000_000, keystrokes: 60, tierBWindows: 1,
        keymapHash: "qwerty-hash",
      },
    ]);
  });

  test("a summary spanning two position spaces fails rather than pooling silently", async () => {
    const { app } = startMultiDeviceLab();
    const response = await fetch(`${app.url}/api/summary?range=all&device=*`);
    expect(response.status).toBe(500);
  });

  test("selecting one keyboard returns that keyboard's geometry only", async () => {
    const { app } = startMultiDeviceLab();
    const glove80 = await (await fetch(`${app.url}/api/summary?range=all&device=1`)).json();
    expect(glove80.header.positionSpace).toBe("glove80");
    expect(glove80.header.totalKeystrokes).toBe(100);
    expect(glove80.positionLoad).toHaveLength(80);

    const laptop = await (await fetch(`${app.url}/api/summary?range=all&device=2`)).json();
    expect(laptop.header.positionSpace).toBe("qwerty-ansi");
    expect(laptop.header.totalKeystrokes).toBe(60);
  });

  test("a non-Glove80 space is ordered row-major rather than by Glove80 coordinates", () => {
    const positions = [
      { pos: 5, hand: "R", row: 3, col: 2 },
      { pos: 1, hand: "L", row: 1, col: 6 },
      { pos: 4, hand: "L", row: 3, col: 6 },
      { pos: 2, hand: "L", row: 1, col: 2 },
    ];
    expect(orderForPositionSpace("qwerty-ansi", positions).map((cell) => cell.pos))
      .toEqual([1, 2, 4, 5]);
  });
});

describe("correction layer", () => {
  function startCorrectionLab() {
    const fixture = createCorrectionFixture();
    fixtures.push(fixture);
    const app = createLabServer(testOptions(fixture));
    apps.push(app);
    return { fixture, app };
  }

  async function loadLayer(app: LabApp, latency = "all") {
    const summary = await (await fetch(
      `${app.url}/api/summary?range=all&device=1&corrections=${latency}`,
    )).json();
    const positionOf = (keycode: string) => summary.positionLoad
      .find((position: { baseKeycode: string | null }) => position.baseKeycode === keycode).pos;
    return {
      layer: summary.correctionLayer,
      key: (keycode: string) => summary.correctionLayer.positions
        .find((entry: { pos: number }) => entry.pos === positionOf(keycode)),
    };
  }

  test("correction intensity is a rate, not a count", async () => {
    const { app } = startCorrectionLab();
    const { key } = await loadLayer(app);
    // V is corrected more often than P in absolute terms, because V is pressed ten times as often.
    // Drawing the count would simply redraw the frequency heatmap; the rate says P is the problem.
    expect(key("KEY_V").corrections).toBeGreaterThan(key("KEY_P").corrections);
    expect(key("KEY_P").rate).toBeGreaterThan(key("KEY_V").rate);
    expect(key("KEY_P").rate).toBeCloseTo(0.5, 10);
    expect(key("KEY_V").rate).toBeCloseTo(0.06, 10);
  });

  test("positions below the press floor render as no data", async () => {
    const { app } = startCorrectionLab();
    const { layer, key } = await loadLayer(app);
    // Z has the highest raw rate in the fixture — 3 corrections in 4 presses — and four presses is
    // not a measurement. It must not be drawn, and it must not set the scale for everything else.
    expect(key("KEY_Z")).toMatchObject({ corrections: 3, presses: 4, rate: null });
    expect(layer.pressFloor).toBe(CORRECTION_PRESS_FLOOR);
    expect(layer.belowFloor).toBe(1);
    expect(layer.maximumRate).toBeCloseTo(0.5, 10);
    // A key with presses but no corrections is a measured zero, not missing data.
    expect(key("KEY_M").rate).toBeCloseTo(0.06, 10);
  });

  test("the fumble filter separates a mistyped key from a rewritten one", async () => {
    const { app } = startCorrectionLab();
    const fumbles = await loadLayer(app, "fumble");
    const edits = await loadLayer(app, "edit");
    // M and V are pressed and corrected identically; only the latency bucket differs.
    expect(fumbles.key("KEY_V").rate).toBeCloseTo(0.06, 10);
    expect(fumbles.key("KEY_M").rate).toBe(0);
    expect(edits.key("KEY_M").rate).toBeCloseTo(0.06, 10);
    expect(edits.key("KEY_V").rate).toBe(0);
  });

  test("reports the corrections that have no position to draw", async () => {
    const { app } = startCorrectionLab();
    const { layer } = await loadLayer(app);
    expect(layer.corrections).toBe(173);
    expect(layer.withoutPosition).toMatchObject({ unattributed: 7, absent: 0 });
    expect(layer.withoutPosition.share).toBeCloseTo(7 / 180, 10);
  });

  test("refuses to draw across position spaces", async () => {
    const fixture = createMultiDeviceFixture();
    fixtures.push(fixture);
    const app = createLabServer(testOptions(fixture));
    apps.push(app);
    expect((await fetch(`${app.url}/api/summary?range=all&device=*`)).status).toBe(500);

    // And the n-gram read carries its own guard rather than relying on Tier B failing first: an
    // ordered trigram means nothing once two keyboards' geometries are summed into it.
    const database = openKeylabDatabase(fixture.path);
    try {
      const meta = loadAnalysisMeta(database, fixture.metaPath);
      expect(() => getCorrectionContext(
        database,
        meta,
        parseLabRange("all", FIXTURE_NOW),
        resolveProfileScope(database),
        resolveDeviceScope(database),
      )).toThrow("Refusing to pool Tier C");
    } finally {
      database.close();
    }
  });
});

describe("control endpoint", () => {
  test("reports the daemon's authoritative state, not Lab's own", async () => {
    const { fixture, app } = startLab();
    const writer = new Database(fixture.path);
    try {
      writer.query("UPDATE live_snapshot SET json = ? WHERE id = 1").run(
        JSON.stringify({
          finger_count: Array(10).fill(0),
          keystrokes_per_minute: 0,
          paused: true,
          profile: "gaming",
          profiles: ["default", "gaming"],
        }),
      );
    } finally {
      writer.close();
    }
    const response = await fetch(`${app.url}/api/control`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      paused: true,
      profile: "gaming",
      profiles: ["default", "gaming"],
    });
  });

  test("falls back to the configured profiles when the snapshot predates the control fields", async () => {
    const { fixture, app } = startLab();
    const writer = new Database(fixture.path);
    try {
      writer.query("UPDATE live_snapshot SET json = ? WHERE id = 1").run(
        JSON.stringify({ finger_count: Array(10).fill(0), keystrokes_per_minute: 0 }),
      );
    } finally {
      writer.close();
    }
    const body = await (await fetch(`${app.url}/api/control`)).json();
    expect(body).toMatchObject({
      paused: false,
      profile: "default",
      profiles: ["default", "training-de", "training-en", "gaming"],
    });
  });

  test("accepts a control POST from the localhost spelling of its own origin", async () => {
    const { app } = startLab();
    // The page is reachable as both 127.0.0.1 and localhost, and the browser sends the origin it
    // was loaded from. Accepting only one spelling 403s every switch made from the other.
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${new URL(app.url).port}`,
      },
      body: JSON.stringify({ profile: "gaming" }),
    });
    expect(response.status).toBe(204);
  });

  test("rejects a control POST from a foreign origin", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ profile: "gaming" }),
    });
    expect(response.status).toBe(403);
  });

  test("rejects a control POST without a JSON content type", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "profile=gaming",
    });
    expect(response.status).toBe(415);
  });

  test("rejects an unconfigured profile name", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "not-a-profile" }),
    });
    expect(response.status).toBe(400);
  });

  test("accepts a same-origin POST and writes the control file atomically", async () => {
    const { fixture, app } = startLab();
    const controlPath = join(fixture.directory, "control.json");
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ profile: "gaming", paused: true }),
    });
    expect(response.status).toBe(204);
    expect(JSON.parse(readFileSync(controlPath, "utf8"))).toMatchObject({
      paused: true,
      profile: "gaming",
    });

    // A partial update must preserve the field it does not mention.
    const second = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect(second.status).toBe(204);
    expect(JSON.parse(readFileSync(controlPath, "utf8"))).toMatchObject({
      paused: false,
      profile: "gaming",
    });
  });

  test("still rejects every other method and path", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/api/summary?range=all`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("unified training API", () => {
  const post = (app: LabApp, path: string, body: unknown) => fetch(`${app.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.url },
    body: JSON.stringify(body),
  });

  function enableTrainingProfiles(fixture: SeededFixture) {
    const writer = new Database(fixture.path);
    try {
      const row = writer.query("SELECT json FROM live_snapshot WHERE id = 1").get() as { json: string };
      writer.query("UPDATE live_snapshot SET json = ? WHERE id = 1").run(JSON.stringify({
        ...JSON.parse(row.json),
        profile: "default",
        profiles: ["default", "training-de", "training-en", "gaming", "training-code"],
      }));
    } finally {
      writer.close();
    }
  }

  test("keeps an active prompt in memory and atomically persists only its completion", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => true });
    enableTrainingProfiles(fixture);
    const startedResponse = await post(app, "/api/training/start", {
      mode: "benchmark",
      language: "en",
      seed: 7,
      wordCount: 3,
    });
    expect(startedResponse.status).toBe(200);
    const started = await startedResponse.json();
    expect(started).toMatchObject({
      mode: "benchmark",
      keylabProfile: "training-en",
      captureMode: "keylab",
    });
    expect(app.store.sessions()).toEqual([]);
    expect(app.activeTrainingSessions()).toBe(1);
    const control = JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8"));
    expect(control).toMatchObject({
      profile: "training-en",
      profile_lease: { id: expect.any(String), restore_profile: "default" },
    });
    expect((await post(app, "/api/control", { paused: true })).status).toBe(204);
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .toMatchObject({ paused: true, profile_lease: { id: control.profile_lease.id } });

    const finishedResponse = await post(app, "/api/training/finish", {
      token: started.token,
      keystrokes: [{ tsMs: 100, code: "KeyA", expectedCode: "KeyA", correct: true }],
      corrections: [],
    });
    expect(finishedResponse.status).toBe(200);
    const finished = await finishedResponse.json();
    expect(finished.sessionId).toBe(1);
    expect(app.activeTrainingSessions()).toBe(0);
    expect(app.store.sessions()).toHaveLength(1);
    expect(app.store.session(1)).toMatchObject({
      endedTs: FIXTURE_NOW,
      keylabProfile: "training-en",
      drillFamily: null,
    });
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .toMatchObject({ paused: true, profile: "default" });
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .not.toHaveProperty("profile_lease");

    const history = await (await fetch(`${app.url}/api/training/history`)).json();
    expect(history.sessions).toHaveLength(1);
    expect(history.benchmark.points).toHaveLength(1);
  });

  test("an external profile change terminates the session before it can save a false capture label", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => true });
    enableTrainingProfiles(fixture);
    const started = await (await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    })).json();
    expect((await post(app, "/api/control", { profile: "gaming" })).status).toBe(204);
    const heartbeat = await post(app, "/api/training/heartbeat", { token: started.token });
    expect(heartbeat.status).toBe(409);
    expect(await heartbeat.json()).toMatchObject({ code: "lease-lost" });
    expect(app.activeTrainingSessions()).toBe(0);
    const finish = await post(app, "/api/training/finish", {
      token: started.token,
      keystrokes: [{ tsMs: 100, code: "KeyA", expectedCode: "KeyA", correct: true }],
      corrections: [],
    });
    expect(finish.status).toBe(404);
    expect(app.store.sessions()).toEqual([]);
    const control = JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8"));
    expect(control.profile).toBe("gaming");
    expect(control).not.toHaveProperty("profile_lease");
  });

  test("finish revalidates lease ownership immediately before persistence", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => true });
    enableTrainingProfiles(fixture);
    const started = await (await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    })).json();
    expect((await post(app, "/api/control", { profile: "gaming" })).status).toBe(204);

    const finish = await post(app, "/api/training/finish", {
      token: started.token,
      keystrokes: [{ tsMs: 100, code: "KeyA", expectedCode: "KeyA", correct: true }],
      corrections: [],
    });

    expect(finish.status).toBe(409);
    expect(await finish.json()).toMatchObject({ code: "lease-lost" });
    expect(app.activeTrainingSessions()).toBe(0);
    expect(app.store.sessions()).toEqual([]);
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .toMatchObject({ profile: "gaming" });
  });

  test("acquires and restores against the current control file rather than a stale snapshot", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => true });
    enableTrainingProfiles(fixture);
    const controlPath = join(fixture.directory, "control.json");
    writeFileSync(controlPath, JSON.stringify({
      paused: false,
      profile: "gaming",
      updated_at: FIXTURE_NOW,
    }));

    const started = await (await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    })).json();
    expect(JSON.parse(readFileSync(controlPath, "utf8")))
      .toMatchObject({ profile: "training-en", profile_lease: { restore_profile: "gaming" } });
    await post(app, "/api/training/cancel", { token: started.token });
    expect(JSON.parse(readFileSync(controlPath, "utf8")))
      .toMatchObject({ profile: "gaming" });
  });

  test("does not overwrite a current lease that the live snapshot has not published yet", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => true });
    enableTrainingProfiles(fixture);
    const controlPath = join(fixture.directory, "control.json");
    writeFileSync(controlPath, JSON.stringify({
      paused: false,
      profile: "training-de",
      updated_at: FIXTURE_NOW,
      profile_lease: {
        id: "newer-owner",
        restore_profile: "gaming",
        expires_at: FIXTURE_NOW + 60,
      },
    }));

    const response = await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "training-busy" });
    expect(JSON.parse(readFileSync(controlPath, "utf8")))
      .toMatchObject({ profile: "training-de", profile_lease: { id: "newer-owner" } });
  });

  test("renews a lease successfully and expires an abandoned browser session", async () => {
    let now = FIXTURE_NOW;
    const { fixture, app } = startLab({ confirmProfileLease: () => true, now: () => now });
    enableTrainingProfiles(fixture);
    const first = await (await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    })).json();
    now += 10;
    const heartbeat = await post(app, "/api/training/heartbeat", { token: first.token });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ leaseExpiresAt: now + 60 });
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .toMatchObject({ profile_lease: { expires_at: now + 60 } });

    now += 61;
    const lateHeartbeat = await post(app, "/api/training/heartbeat", { token: first.token });
    expect(lateHeartbeat.status).toBe(404);
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .not.toHaveProperty("profile_lease");
    const second = await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    });
    expect(second.status).toBe(200);
    const replacement = await second.json();
    expect(replacement).toMatchObject({ captureMode: "trainer-only" });
    expect(app.activeTrainingSessions()).toBe(1);
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .not.toHaveProperty("profile_lease");
    await post(app, "/api/training/cancel", { token: replacement.token });
  });

  test("reports invalid training configuration as a client error", async () => {
    const { app } = startLab();
    const response = await post(app, "/api/training/start", {
      mode: "invalid", language: "en", wordCount: 2,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid-request" });
  });

  test("rejects every non-object JSON mutation body as a client error", async () => {
    const { app } = startLab();
    for (const [path, body] of [
      ["/api/control", null],
      ["/api/training/start", []],
      ["/api/training/heartbeat", null],
      ["/api/training/finish", 42],
      ["/api/training/cancel", "token"],
    ] as const) {
      const response = await post(app, path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid-request" });
    }
  });

  test("returns a saved result when post-commit lease restoration temporarily fails", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => true });
    const manager = createTrainingManager({
      store: app.store,
      controlPath: join(fixture.directory, "control.json"),
      now: () => FIXTURE_NOW,
      restoreLease: () => { throw new Error("simulated restore failure"); },
    });
    const started = await manager.start({ mode: "benchmark", language: "en", wordCount: 2 }, {
      captureAvailable: true,
      control: {
        paused: false,
        profile: "default",
        profiles: ["default", "training-de", "training-en", "gaming"],
        layer: null,
        keystrokes_per_minute: 0,
      },
      confirmLease: async () => true,
    });

    const finished = manager.finish({
      token: started.token,
      keystrokes: [{ tsMs: 100, code: "KeyA", expectedCode: "KeyA", correct: true }],
      corrections: [],
    });

    expect(finished).toMatchObject({
      sessionId: 1,
      warning: expect.stringContaining("result is saved"),
    });
    expect(app.store.sessions()).toHaveLength(1);
    expect(manager.activeCount()).toBe(0);
    expect(() => manager.finish({ token: started.token, keystrokes: [], corrections: [] }))
      .toThrow("Active session not found");
  });

  test("requires authoritative lease confirmation and restores immediately when it fails", async () => {
    const { fixture, app } = startLab({ confirmProfileLease: () => false });
    enableTrainingProfiles(fixture);
    const response = await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "profile-unconfirmed" });
    expect(app.activeTrainingSessions()).toBe(0);
    expect(app.store.sessions()).toEqual([]);
    expect(JSON.parse(readFileSync(join(fixture.directory, "control.json"), "utf8")))
      .toMatchObject({ profile: "default" });
  });

  test("never resumes paused capture and requires an explicit trainer-only choice", async () => {
    const { app } = startLab({ confirmProfileLease: () => true });
    expect((await post(app, "/api/control", { paused: true })).status).toBe(204);
    const blocked = await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2,
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "capture-paused" });

    const trainerOnly = await post(app, "/api/training/start", {
      mode: "benchmark", language: "en", wordCount: 2, trainerOnly: true,
    });
    expect(trainerOnly.status).toBe(200);
    const session = await trainerOnly.json();
    expect(session).toMatchObject({ captureMode: "trainer-only", keylabProfile: null });
    expect(session.warning).toContain("did not resume it");
    await post(app, "/api/training/cancel", { token: session.token });

    const mechanic = await post(app, "/api/training/start", {
      mode: "drill", family: "mechanic", trainerOnly: true,
    });
    expect(mechanic.status).toBe(409);
    expect(await mechanic.json()).toMatchObject({ code: "capture-required" });
  });
});

describe("SSE", () => {
  test("emits an event only after live_snapshot.updated_at changes", async () => {
    const { fixture, app } = startLab();
    const response = await fetch(`${app.url}/events`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");
    const decoder = new TextDecoder();
    const connected = await reader.read();
    expect(decoder.decode(connected.value)).toContain(": connected");

    const writer = new Database(fixture.path);
    try {
      writer.query("UPDATE live_snapshot SET updated_at = ? WHERE id = 1").run(FIXTURE_NOW + 1);
    } finally {
      writer.close();
    }

    const event = await Promise.race([
      reader.read().then((chunk) => decoder.decode(chunk.value)),
      delay(1_000).then(() => "timeout"),
    ]);
    expect(event).toContain("event: snapshot");
    expect(event).toContain(`"updatedAt":${FIXTURE_NOW + 1}`);
    await reader.cancel();
  });

  test("does not emit a snapshot event while updated_at is unchanged", async () => {
    const { app } = startLab();
    const response = await fetch(`${app.url}/events`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response has no body");
    await reader.read();
    const outcome = await Promise.race([
      reader.read().then((chunk) => new TextDecoder().decode(chunk.value)),
      delay(120).then(() => "no-event"),
    ]);
    expect(outcome).toBe("no-event");
    await reader.cancel();
  });

  test("cleans up polling intervals across repeated disconnects", async () => {
    const { app } = startLab();
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const controller = new AbortController();
      const response = await fetch(`${app.url}/events`, { signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SSE response has no body");
      await reader.read();
      controller.abort();
    }
    await delay(40);
    expect(app.activeSsePollers()).toBe(0);
  });
});

describe("Lab boundaries and geometry", () => {
  test("rejects --host 0.0.0.0", () => {
    expect(() => parseLabArgs(["--host", "0.0.0.0"]))
      .toThrow("only 127.0.0.1 or localhost is allowed");
  });

  test("heatmap helper emits 80 cells in toPhysicalRows order", () => {
    const expected = toPhysicalRows(positionStructuredLayout()).flat().map(Number);
    const geometry = buildHeatmapGeometry();
    expect(geometry).toHaveLength(80);
    expect(geometry.map((cell) => cell.pos)).toEqual(expected);
    expect(new Set(geometry.map((cell) => cell.pos)).size).toBe(80);
    expect(geometry.find((cell) => cell.pos === 52)).toMatchObject({ x: 371, y: 312, rotation: 30 });
    expect(geometry.find((cell) => cell.pos === 72)).toMatchObject({ x: 598, y: 427, rotation: -60 });
  });

  test("queues one trailing refresh when notified during an in-flight refresh", async () => {
    let calls = 0;
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const refresh = createRefreshScheduler(async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
    });

    const first = refresh();
    await delay(0);
    await refresh();
    expect(calls).toBe(1);
    releaseFirst();
    await first;
    expect(calls).toBe(2);
  });
});

describe("browser view model", () => {
  test("tracks the rendered route independently of a popstate URL", () => {
    const tracker = createRouteTracker("/train", "/train?family=bigram");
    expect(tracker.leaves("/history")).toBe(true);
    expect(tracker.current()).toBe("/train?family=bigram");
    tracker.commit("/history", "/history?mode=benchmark");
    expect(tracker.leaves("/history")).toBe(false);
    expect(tracker.current()).toBe("/history?mode=benchmark");
    tracker.replaceLocation("/history?mode=drill");
    expect(tracker.current()).toBe("/history?mode=drill");
  });

  test("enables mechanic drills only for usable capture", () => {
    expect(mechanicAvailable({ service: "active", capture: "fresh", paused: false })).toBe(true);
    expect(mechanicAvailable({ service: "inactive", capture: "fresh", paused: false })).toBe(false);
    expect(mechanicAvailable({ service: "active", capture: "stale", paused: false })).toBe(false);
    expect(mechanicAvailable({ service: "active", capture: "fresh", paused: true })).toBe(false);
  });

  test("the overview recommendation selects a concrete drill family", () => {
    expect(recommendedDrill({ positions: [{}], correctedTransitions: [{}] })).toBe("position");
    expect(recommendedDrill({ positions: [], correctedTransitions: [{}] })).toBe("bigram");
    expect(recommendedDrill({ positions: [], correctedTransitions: [], mechanics: [{}] }))
      .toBe("mechanic");
    expect(recommendedDrill({})).toBe("language");
  });

  test("only server-terminal training errors discard the browser session", () => {
    expect(trainingErrorIsTerminal("lease-lost")).toBe(true);
    expect(trainingErrorIsTerminal("not-found")).toBe(true);
    expect(trainingErrorIsTerminal("internal-error")).toBe(false);
    expect(trainingErrorIsTerminal(undefined)).toBe(false);
  });

  test("a successful status transition clears prior error styling", () => {
    const classes = new Set<string>();
    const target = {
      textContent: "",
      classList: {
        toggle(name: string, force = false) {
          if (force) classes.add(name); else classes.delete(name);
          return force;
        },
      },
    };
    applyStatus(target, "failed", true);
    expect(target.textContent).toBe("failed");
    expect(classes.has("error")).toBe(true);

    applyStatus(target, "recovered");
    expect(target.textContent).toBe("recovered");
    expect(classes.has("error")).toBe(false);
  });

  test("a pending switch survives a refresh that reports the old profile", () => {
    const tracker = createControlTracker();
    tracker.request("gaming", 1_000);
    // The daemon writes `live_snapshot` about once a second, so the next refresh still reports the
    // profile it was on. Showing that back would make an accepted switch look rejected, and the
    // user switches again into the same window.
    expect(tracker.observe({ profile: "default" }, 1_200)).toBe("gaming");
    expect(tracker.status()).toEqual({ text: "Switching to gaming…", isError: false });

    expect(tracker.observe({ profile: "gaming" }, 1_900)).toBe("gaming");
    expect(tracker.status()).toEqual({ text: "Live connection active", isError: false });
  });

  test("a switch the daemon never confirms is reported after the timeout", () => {
    const tracker = createControlTracker();
    tracker.request("gaming", 0);
    expect(tracker.observe({ profile: "default" }, PROFILE_CONFIRM_MS)).toBe("gaming");

    // Past the deadline the selection snaps back to the daemon's word rather than showing a state
    // it never accepted, and says which is which: an idle auto-revert looks identical otherwise.
    expect(tracker.observe({ profile: "default" }, PROFILE_CONFIRM_MS + 1)).toBe("default");
    expect(tracker.status()).toEqual({
      text: "The daemon did not switch to gaming; it still reports default.",
      isError: true,
    });

    // It survives every later refresh tick, or the report is erased a second after it appears.
    tracker.observe({ profile: "default" }, PROFILE_CONFIRM_MS + 30_000);
    expect(tracker.status().isError).toBe(true);
    tracker.request("gaming", 60_000);
    expect(tracker.status()).toEqual({ text: "Switching to gaming…", isError: false });
  });

  test("the correction footnote states the floor, the hidden count and the off-board share", () => {
    const layer = {
      latency: "all",
      corrections: 1_234,
      pressFloor: 50,
      belowFloor: 3,
      withoutPosition: { unattributed: 7, absent: 2, share: 9 / 180 },
    };
    const footnote = correctionFootnote(layer);
    // A layer that silently omits the positions it cannot rate, and the corrections that had no
    // position at all, reads as a complete picture of corrections. All three numbers are stated.
    expect(footnote).toContain("1,234 corrections on drawable positions");
    expect(footnote).toContain("under 50 presses in range show no data");
    expect(footnote).toContain("(3 hidden that carry corrections)");
    expect(footnote).toContain("5.00% had no position to draw");
    expect(footnote).toContain("7 unattributed, 2 with no key before the correction");
    expect(footnote).toContain("Ambiguous corrections (400–1000 ms) count here");

    // Ambiguous corrections count under `all` and nowhere else, so only `all` may say so.
    expect(correctionFootnote({ ...layer, latency: "fumble" })).not.toContain("Ambiguous");
    // Nothing hidden and nothing off the board: no parenthetical, no share sentence.
    const clean = correctionFootnote({
      ...layer,
      belowFloor: 0,
      withoutPosition: { unattributed: 0, absent: 0, share: 0 },
    });
    expect(clean).toContain("under 50 presses in range show no data.");
    expect(clean).not.toContain("had no position to draw");
  });

  test("the rate scale is linear against the worst rate on the board", () => {
    // Half the worst rate is half the scale. The log curve `level()` uses for counts would put it
    // at 6 and push nearly every mid rate to the top, which is the whole reason this is separate.
    expect(rateLevel(0.25, 0.5)).toBe(5);
    expect(rateLevel(0.5, 0.5)).toBe(10);
    expect(rateLevel(0.05, 0.5)).toBe(1);
    // A measured zero is the empty step; a rate above zero never is, however small.
    expect(rateLevel(0, 0.5)).toBe(0);
    expect(rateLevel(0.0001, 0.5)).toBe(1);
    // Nothing to scale against: no board-wide maximum means no level.
    expect(rateLevel(0.2, 0)).toBe(0);
  });
});
