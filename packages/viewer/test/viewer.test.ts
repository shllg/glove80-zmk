import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openKeylabDatabase } from "../../analysis/src/db";
import { loadAnalysisMeta } from "../../analysis/src/meta";
import {
  calculateMetrics,
  getCorrectionContext,
  parseViewerRange,
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
  CORRECTION_PRESS_FLOOR,
  createViewerServer,
  parseViewerArgs,
  type ViewerApp,
} from "../src/server";

const fixtures: SeededFixture[] = [];
const apps: ViewerApp[] = [];
const silentLogger = { log() {}, error() {} };

afterEach(() => {
  for (const app of apps.splice(0)) app.stop();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function testOptions(
  fixture: SeededFixture,
  options: { pollIntervalMs?: number; keepaliveIntervalMs?: number } = {},
) {
  return {
    dbPath: fixture.path,
    metaPath: fixture.metaPath,
    host: "127.0.0.1" as const,
    port: 0,
    now: () => FIXTURE_NOW,
    pollIntervalMs: options.pollIntervalMs ?? 20,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? 10_000,
    logger: silentLogger,
    profiles: ["default", "training-de", "training-en", "gaming"],
    controlPath: join(fixture.directory, "control.json"),
  };
}

function startViewer(options: { pollIntervalMs?: number; keepaliveIntervalMs?: number } = {}) {
  const fixture = createFixture();
  fixtures.push(fixture);
  const app = createViewerServer(testOptions(fixture, options));
  apps.push(app);
  return { fixture, app };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("viewer API", () => {
  test("summary returns the same analysis numbers for a seeded database", async () => {
    const { fixture, app } = startViewer();
    const response = await fetch(`${app.url}/api/summary?range=7d`);
    expect(response.status).toBe(200);
    // The correction layer is the viewer's own derivation; everything else must still be exactly
    // what the analysis package computed, with no viewer-side reinterpretation in between.
    const { correctionLayer, ...actual } = await response.json();
    expect(correctionLayer.pressFloor).toBe(CORRECTION_PRESS_FLOOR);

    const database = openKeylabDatabase(fixture.path);
    try {
      const meta = loadAnalysisMeta(database, fixture.metaPath);
      const expected = calculateMetrics(database, meta, parseViewerRange("7d", FIXTURE_NOW), {
        profile: "*",
      });
      expect(actual).toEqual(expected);
    } finally {
      database.close();
    }
  });

  test("security headers are present on the page and API", async () => {
    const { app } = startViewer();
    for (const path of ["/", "/api/summary?range=live"]) {
      const response = await fetch(`${app.url}${path}`);
      expect(response.headers.get("content-security-policy"))
        .toBe("default-src 'self'; connect-src 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("serves the browser module graph entirely from local assets", async () => {
    const { app } = startViewer();
    const page = await fetch(`${app.url}/`);
    expect(await page.text()).toContain('<script src="/app.js" type="module"></script>');
    const scheduler = await fetch(`${app.url}/refresh-scheduler.js`);
    expect(scheduler.status).toBe(200);
    expect(scheduler.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await scheduler.text()).toContain("export function createRefreshScheduler");
  });

  test("unknown routes return 404 without a stack trace", async () => {
    const { app } = startViewer();
    const response = await fetch(`${app.url}/not-a-route`);
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toBe("Not found\n");
    expect(body).not.toContain("at ");
  });

  test("rejects a hostile Host header before routing", async () => {
    const { app } = startViewer();
    const response = await fetch(`${app.url}/api/summary?range=all`, {
      headers: { Host: "attacker.example:4123" },
    });
    expect(response.status).toBe(421);
    expect(await response.text()).toBe("Misdirected request\n");
  });
});

describe("profile scope", () => {
  function startProfileViewer() {
    const fixture = createProfileFixture();
    fixtures.push(fixture);
    const app = createViewerServer(testOptions(fixture));
    apps.push(app);
    return { fixture, app };
  }

  const total = (summary: { header: { totalKeystrokes: number } }) => summary.header.totalKeystrokes;

  test("pools every profile unless one is named", async () => {
    const { app } = startProfileViewer();
    // The analysis default is the `default` profile, which is right for a report that names its
    // scope and wrong here: a dashboard scoped to one profile drops everything typed under the
    // others while its totals still read as the whole picture.
    const pooled = await (await fetch(`${app.url}/api/summary?range=all`)).json();
    expect(total(pooled)).toBe(140);
    expect(pooled.header.profile).toBe("* (all profiles)");
  });

  test("scopes to one profile when asked, and says which", async () => {
    const { app } = startProfileViewer();
    const gaming = await (await fetch(`${app.url}/api/summary?range=all&profile=gaming`)).json();
    expect(total(gaming)).toBe(40);
    expect(gaming.header.profile).toBe("gaming");

    const standard = await (await fetch(`${app.url}/api/summary?range=all&profile=default`)).json();
    expect(total(standard)).toBe(100);
    expect(total(standard) + total(gaming)).toBe(140);
  });
});

describe("multi-device viewer", () => {
  function startMultiDeviceViewer() {
    const fixture = createMultiDeviceFixture();
    fixtures.push(fixture);
    const app = createViewerServer(testOptions(fixture));
    apps.push(app);
    return { fixture, app };
  }

  test("lists every device that has data, with what tells two rows of one keyboard apart", async () => {
    const { app } = startMultiDeviceViewer();
    const devices = await (await fetch(`${app.url}/api/devices`)).json();
    // Name and position space alone are identical for two rows of the same keyboard, which an
    // older daemon minted on every reconnect. The counts and first-seen time are what separate them.
    expect(devices).toEqual([
      {
        id: 1, name: "Evsieve Virtual Device", positionSpace: "glove80",
        firstTs: FIXTURE_NOW - 1_000_000, keystrokes: 100, tierBWindows: 1,
      },
      {
        id: 2, name: "AT Translated Set 2 keyboard", positionSpace: "qwerty-ansi",
        firstTs: FIXTURE_NOW - 1_000_000, keystrokes: 60, tierBWindows: 1,
      },
    ]);
  });

  test("a summary spanning two position spaces fails rather than pooling silently", async () => {
    const { app } = startMultiDeviceViewer();
    const response = await fetch(`${app.url}/api/summary?range=all&device=*`);
    expect(response.status).toBe(500);
  });

  test("selecting one keyboard returns that keyboard's geometry only", async () => {
    const { app } = startMultiDeviceViewer();
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
  function startCorrectionViewer() {
    const fixture = createCorrectionFixture();
    fixtures.push(fixture);
    const app = createViewerServer(testOptions(fixture));
    apps.push(app);
    return { fixture, app };
  }

  async function loadLayer(app: ViewerApp, latency = "all") {
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
    const { app } = startCorrectionViewer();
    const { key } = await loadLayer(app);
    // V is corrected more often than P in absolute terms, because V is pressed ten times as often.
    // Drawing the count would simply redraw the frequency heatmap; the rate says P is the problem.
    expect(key("KEY_V").corrections).toBeGreaterThan(key("KEY_P").corrections);
    expect(key("KEY_P").rate).toBeGreaterThan(key("KEY_V").rate);
    expect(key("KEY_P").rate).toBeCloseTo(0.5, 10);
    expect(key("KEY_V").rate).toBeCloseTo(0.06, 10);
  });

  test("positions below the press floor render as no data", async () => {
    const { app } = startCorrectionViewer();
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
    const { app } = startCorrectionViewer();
    const fumbles = await loadLayer(app, "fumble");
    const edits = await loadLayer(app, "edit");
    // M and V are pressed and corrected identically; only the latency bucket differs.
    expect(fumbles.key("KEY_V").rate).toBeCloseTo(0.06, 10);
    expect(fumbles.key("KEY_M").rate).toBe(0);
    expect(edits.key("KEY_M").rate).toBeCloseTo(0.06, 10);
    expect(edits.key("KEY_V").rate).toBe(0);
  });

  test("reports the corrections that have no position to draw", async () => {
    const { app } = startCorrectionViewer();
    const { layer } = await loadLayer(app);
    expect(layer.corrections).toBe(173);
    expect(layer.withoutPosition).toMatchObject({ unattributed: 7, absent: 0 });
    expect(layer.withoutPosition.share).toBeCloseTo(7 / 180, 10);
  });

  test("refuses to draw across position spaces", async () => {
    const fixture = createMultiDeviceFixture();
    fixtures.push(fixture);
    const app = createViewerServer(testOptions(fixture));
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
        parseViewerRange("all", FIXTURE_NOW),
        resolveProfileScope(database),
        resolveDeviceScope(database),
      )).toThrow("Refusing to pool Tier C");
    } finally {
      database.close();
    }
  });
});

describe("control endpoint", () => {
  test("reports the daemon's authoritative state, not the viewer's own", async () => {
    const { fixture, app } = startViewer();
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
    const { fixture, app } = startViewer();
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
    const { app } = startViewer();
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
    const { app } = startViewer();
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ profile: "gaming" }),
    });
    expect(response.status).toBe(403);
  });

  test("rejects a control POST without a JSON content type", async () => {
    const { app } = startViewer();
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "profile=gaming",
    });
    expect(response.status).toBe(415);
  });

  test("rejects an unconfigured profile name", async () => {
    const { app } = startViewer();
    const response = await fetch(`${app.url}/api/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "not-a-profile" }),
    });
    expect(response.status).toBe(400);
  });

  test("accepts a same-origin POST and writes the control file atomically", async () => {
    const { fixture, app } = startViewer();
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
    const { app } = startViewer();
    const response = await fetch(`${app.url}/api/summary?range=all`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("SSE", () => {
  test("emits an event only after live_snapshot.updated_at changes", async () => {
    const { fixture, app } = startViewer();
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
    const { app } = startViewer();
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
    const { app } = startViewer();
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

describe("viewer boundaries and geometry", () => {
  test("rejects --host 0.0.0.0", () => {
    expect(() => parseViewerArgs(["--host", "0.0.0.0"]))
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
