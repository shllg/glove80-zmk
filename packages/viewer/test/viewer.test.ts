import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openKeylabDatabase } from "../../analysis/src/db";
import { loadAnalysisMeta } from "../../analysis/src/meta";
import { calculateMetrics, parseViewerRange } from "../../analysis/src/metrics";
import { createFixture, FIXTURE_NOW, type SeededFixture } from "../../analysis/test/fixture";
import { toPhysicalRows } from "../../keymap/src/layout";
import { buildHeatmapGeometry, positionStructuredLayout } from "../src/geometry";
import { createRefreshScheduler } from "../public/refresh-scheduler.js";
import {
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

function startViewer(options: { pollIntervalMs?: number; keepaliveIntervalMs?: number } = {}) {
  const fixture = createFixture();
  fixtures.push(fixture);
  const app = createViewerServer({
    dbPath: fixture.path,
    metaPath: fixture.metaPath,
    host: "127.0.0.1",
    port: 0,
    now: () => FIXTURE_NOW,
    pollIntervalMs: options.pollIntervalMs ?? 20,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? 10_000,
    logger: silentLogger,
  });
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
    const actual = await response.json();

    const database = openKeylabDatabase(fixture.path);
    try {
      const meta = loadAnalysisMeta(database, fixture.metaPath);
      const expected = calculateMetrics(database, meta, parseViewerRange("7d", FIXTURE_NOW));
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
