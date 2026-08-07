#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openKeylabDatabase } from "@glove80/analysis/db";
import { loadAnalysisMeta } from "@glove80/analysis/meta";
import {
  ALL_PROFILES,
  calculateMetrics,
  parseViewerRange,
  type AnalysisMetrics,
  type CorrectedPosition,
} from "@glove80/analysis/metrics";
import { orderForPositionSpace } from "./geometry";

const HOST = "127.0.0.1";
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const PUBLIC_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

/** Mirrors `crates/keylab/src/config.rs`'s `Default::default` so the two never drift apart. */
export const DEFAULT_PROFILES = ["default", "training-de", "training-en", "gaming"] as const;

export interface ViewerArgs {
  dbPath: string;
  port: number;
  host: typeof HOST;
  profiles?: string[];
  controlPath?: string;
}

export interface ViewerServerOptions extends ViewerArgs {
  metaPath?: string;
  now?: () => number;
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
  logger?: Pick<Console, "log" | "error">;
}

export interface ControlState {
  paused: boolean;
  profile: string;
  profiles: string[];
}

interface SnapshotRow {
  json: string;
}

export interface ViewerApp {
  server: ReturnType<typeof Bun.serve>;
  database: Database;
  url: string;
  activeSsePollers(): number;
  stop(): void;
}

interface UpdatedAtRow {
  updated_at: number;
}

export function parseViewerArgs(args: string[]): ViewerArgs {
  const parsed: ViewerArgs = {
    dbPath: join(homedir(), ".local/share/glove80-lab/keylab.db"),
    port: 4123,
    host: HOST,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--db") {
      const value = args[index + 1];
      if (!value) throw new Error("--db requires a path");
      parsed.dbPath = resolve(value);
      index += 1;
    } else if (argument === "--port") {
      const value = args[index + 1];
      const port = Number(value);
      if (!value || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer from 1 through 65535");
      }
      parsed.port = port;
      index += 1;
    } else if (argument === "--host") {
      const value = args[index + 1];
      if (!value) throw new Error("--host requires a value");
      if (value !== HOST && value !== "localhost") {
        throw new Error(`Refusing --host ${JSON.stringify(value)}; only 127.0.0.1 or localhost is allowed`);
      }
      parsed.host = HOST;
      index += 1;
    } else if (argument === "--profiles") {
      const value = args[index + 1];
      if (!value) throw new Error("--profiles requires a comma-separated list");
      const names = value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
      if (names.length === 0) throw new Error("--profiles requires at least one name");
      parsed.profiles = names;
      index += 1;
    } else if (argument === "--control") {
      const value = args[index + 1];
      if (!value) throw new Error("--control requires a path");
      parsed.controlPath = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  return parsed;
}

/** The two origins that are this server: `127.0.0.1` and `localhost` on the port it bound. */
export function isSameServerOrigin(origin: string, port: number | undefined): boolean {
  return origin === `http://${HOST}:${port}` || origin === `http://localhost:${port}`;
}

function responseHeaders(contentType: string, extra: HeadersInit = {}): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", contentType);
  const additions = new Headers(extra);
  additions.forEach((value, key) => headers.set(key, value));
  return headers;
}

function staticResponse(fileName: string, contentType: string): Response {
  return new Response(readFileSync(join(PUBLIC_DIRECTORY, fileName)), {
    headers: responseHeaders(contentType),
  });
}

/**
 * The daemon is the only authority on control state: it echoes `paused`, `profile`, and the
 * configured profile list into `live_snapshot`. Reading the viewer's own last write back would
 * show a state the daemon may have rejected or auto-reverted.
 */
function readControlState(database: Database, fallbackProfiles: string[]): ControlState {
  const row = database.query("SELECT json FROM live_snapshot WHERE id = 1").get() as
    | SnapshotRow
    | null;
  const snapshot = row ? (JSON.parse(row.json) as Partial<ControlState>) : {};
  const profiles = Array.isArray(snapshot.profiles) && snapshot.profiles.length > 0
    ? snapshot.profiles
    : fallbackProfiles;
  return {
    paused: snapshot.paused === true,
    profile: typeof snapshot.profile === "string" ? snapshot.profile : (profiles[0] ?? "default"),
    profiles,
  };
}

/** Writes to a sibling temporary file and renames, matching `control::write_control` in the daemon. */
function writeControlFile(path: string, state: { paused: boolean; profile: string }): void {
  const temporary = `${path}.tmp`;
  const payload = `${JSON.stringify(
    { paused: state.paused, profile: state.profile, updated_at: Math.floor(Date.now() / 1000) },
    null,
    2,
  )}\n`;
  const handle = openSync(temporary, "w", 0o600);
  try {
    writeSync(handle, payload);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

function readControlFile(path: string): { paused: boolean; profile: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { paused?: unknown; profile?: unknown };
    if (typeof parsed.paused !== "boolean" || typeof parsed.profile !== "string") return null;
    return { paused: parsed.paused, profile: parsed.profile };
  } catch {
    return null;
  }
}

/**
 * A correction rate needs a denominator before it is a rate at all. A position pressed twice and
 * corrected once is not the worst key on the board, it is two samples — so below this many presses
 * in range the layer draws no data rather than a number that would own the colour scale.
 */
export const CORRECTION_PRESS_FLOOR = 50;

/** `ambiguous` (400-1000 ms) counts only under `all`: it is neither clearly a fumble nor an edit. */
export type CorrectionFilter = "all" | "fumble" | "edit";

export interface CorrectionLayerPosition {
  pos: number;
  corrections: number;
  presses: number;
  /** Corrections per press, or `null` below the press floor — no data, which is not the same as 0. */
  rate: number | null;
}

export interface CorrectionLayer {
  latency: CorrectionFilter;
  pressFloor: number;
  /** Corrections in this filter that landed on a position this keyboard can draw. */
  corrections: number;
  /** Positions carrying corrections but too few presses to rate. Drawn as no-data, never as hot. */
  belowFloor: number;
  maximumRate: number;
  positions: CorrectionLayerPosition[];
  /** `-1` and `-2` have no geometry, so they are footnoted rather than quietly dropped. */
  withoutPosition: { unattributed: number; absent: number; share: number };
}

export function parseCorrectionFilter(value: string | null): CorrectionFilter {
  if (value === null || value === "all") return "all";
  if (value === "fumble" || value === "edit") return value;
  throw new Error(
    `Invalid corrections filter ${JSON.stringify(value)}; expected all, fumble, or edit`,
  );
}

function correctionsIn(entry: CorrectedPosition, latency: CorrectionFilter): number {
  return latency === "all" ? entry.corrections : entry.byLatency[latency];
}

/**
 * Intensity is corrections *per press*, never corrections. A raw count would redraw the frequency
 * heatmap — the keys pressed most are also corrected most in absolute terms — and the difference
 * between "keys I use" and "keys I get wrong" is the entire point of the layer.
 *
 * The layer follows `metrics.positionLoad`, so it is drawn in the same order and on the same
 * geometry the frequency heatmap already chose for this device's position space.
 */
export function buildCorrectionLayer(
  metrics: AnalysisMetrics,
  latency: CorrectionFilter,
): CorrectionLayer {
  const context = metrics.correctionTax.context;
  const byPosition = new Map(context.byPosition.map((entry) => [entry.pos, entry]));
  let corrections = 0;
  let belowFloor = 0;
  let maximumRate = 0;
  const positions = metrics.positionLoad.map((position) => {
    const entry = byPosition.get(position.pos);
    const value = entry ? correctionsIn(entry, latency) : 0;
    corrections += value;
    const rated = position.presses >= CORRECTION_PRESS_FLOOR;
    if (!rated && value > 0) belowFloor += 1;
    const rate = rated ? value / position.presses : null;
    if (rate !== null && rate > maximumRate) maximumRate = rate;
    return { pos: position.pos, corrections: value, presses: position.presses, rate };
  });
  const unattributed = correctionsIn(context.withoutPosition.unattributed, latency);
  const absent = correctionsIn(context.withoutPosition.absent, latency);
  const offBoard = unattributed + absent;
  const total = corrections + offBoard;
  return {
    latency,
    pressFloor: CORRECTION_PRESS_FLOOR,
    corrections,
    belowFloor,
    maximumRate,
    positions,
    withoutPosition: { unattributed, absent, share: total === 0 ? 0 : offBoard / total },
  };
}

export interface ViewerDevice {
  id: number;
  name: string;
  positionSpace: string | null;
  firstTs: number;
  keystrokes: number;
  /** Tier B windows. A device with none has no heatmap to draw, however many keystrokes it holds. */
  tierBWindows: number;
}

/**
 * Devices are named by their evdev name, and one keyboard can hold several rows: an older daemon
 * minted a fresh `device_id` per reconnect, and those rows keep their data. Two entries reading
 * `Evsieve Virtual Device · glove80` are indistinguishable in a menu, so each carries what
 * separates it — its id, when it was first seen, and how much it actually holds.
 */
function readDevices(database: Database): ViewerDevice[] {
  return (database.query(`
    SELECT d.id, d.name, d.keymap_kind AS positionSpace, d.first_ts AS firstTs,
           (SELECT COALESCE(SUM(b.keystrokes), 0) FROM bucket b WHERE b.device_id = d.id)
             AS keystrokes,
           (SELECT COUNT(*) FROM key_window kw WHERE kw.device_id = d.id) AS tierBWindows
    FROM device d
    WHERE EXISTS (SELECT 1 FROM bucket b WHERE b.device_id = d.id)
       OR EXISTS (SELECT 1 FROM key_window kw WHERE kw.device_id = d.id)
    ORDER BY d.id
  `).all() as ViewerDevice[]).map((device) => ({
    id: Number(device.id),
    name: device.name,
    positionSpace: device.positionSpace ?? null,
    firstTs: Number(device.firstTs),
    keystrokes: Number(device.keystrokes),
    tierBWindows: Number(device.tierBWindows),
  }));
}

function readUpdatedAt(database: Database): number | null {
  const row = database.query("SELECT updated_at FROM live_snapshot WHERE id = 1").get() as UpdatedAtRow | null;
  return row ? Number(row.updated_at) : null;
}

function sseResponse(
  request: Request,
  database: Database,
  cleanups: Set<() => void>,
  pollIntervalMs: number,
  keepaliveIntervalMs: number,
  logger: Pick<Console, "error">,
): Response {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let lastUpdatedAt = readUpdatedAt(database);
      let closed = false;
      const enqueue = (value: string) => {
        if (!closed) controller.enqueue(encoder.encode(value));
      };
      enqueue(": connected\n\n");

      const pollTimer = setInterval(() => {
        try {
          const updatedAt = readUpdatedAt(database);
          if (updatedAt !== null && updatedAt !== lastUpdatedAt) {
            lastUpdatedAt = updatedAt;
            enqueue(`event: snapshot\ndata: ${JSON.stringify({ updatedAt })}\n\n`);
          }
        } catch (error) {
          logger.error("viewer SSE poll failed", error);
          cleanup();
        }
      }, pollIntervalMs);
      const keepaliveTimer = setInterval(() => enqueue(": keepalive\n\n"), keepaliveIntervalMs);

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(keepaliveTimer);
        request.signal.removeEventListener("abort", cleanup);
        cleanups.delete(cleanup);
        try {
          controller.close();
        } catch {
          // The client can cancel the stream before the abort signal arrives.
        }
      };
      cleanups.add(cleanup);
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: responseHeaders("text/event-stream; charset=utf-8", {
      Connection: "keep-alive",
    }),
  });
}

export function createViewerServer(options: ViewerServerOptions): ViewerApp {
  if (options.host !== HOST) {
    throw new Error(`Viewer must bind ${HOST}`);
  }
  const logger = options.logger ?? console;
  const database = openKeylabDatabase(options.dbPath);
  let meta;
  try {
    meta = loadAnalysisMeta(database, options.metaPath);
  } catch (error) {
    database.close();
    throw error;
  }
  const cleanups = new Set<() => void>();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? 15_000;
  const profiles = options.profiles ?? [...DEFAULT_PROFILES];
  // The control file lives beside the database, exactly where the daemon looks for it.
  const controlPath = options.controlPath ?? join(dirname(options.dbPath), "control.json");

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: HOST,
      port: options.port,
      async fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.hostname !== HOST && url.hostname !== "localhost") {
            return new Response("Misdirected request\n", {
              status: 421,
              headers: responseHeaders("text/plain; charset=utf-8"),
            });
          }
          if (url.pathname === "/api/control" && request.method === "POST") {
            // A localhost server accepts simple cross-origin POSTs from any page the browser has
            // open. Requiring a JSON content type forces a preflight, which the origin check then
            // rejects.
            //
            // Both spellings of this server are accepted, because both reach it: the routing check
            // above already answers to `localhost`, and a browser sends the origin the page was
            // loaded from. Accepting only `127.0.0.1` rejected every control POST from a page
            // opened as `http://localhost:4123` with a 403 that reads like a security failure
            // rather than a spelling difference. A page on any other origin still cannot post.
            const origin = request.headers.get("origin");
            if (origin !== null && !isSameServerOrigin(origin, server.port)) {
              return new Response("Forbidden\n", {
                status: 403,
                headers: responseHeaders("text/plain; charset=utf-8"),
              });
            }
            if (request.headers.get("content-type") !== "application/json") {
              return new Response("Unsupported media type\n", {
                status: 415,
                headers: responseHeaders("text/plain; charset=utf-8"),
              });
            }
            let body: { paused?: unknown; profile?: unknown };
            try {
              body = (await request.json()) as { paused?: unknown; profile?: unknown };
            } catch {
              return new Response("Malformed JSON\n", {
                status: 400,
                headers: responseHeaders("text/plain; charset=utf-8"),
              });
            }
            if (body.profile !== undefined
              && (typeof body.profile !== "string" || !profiles.includes(body.profile))) {
              return new Response("Unknown profile\n", {
                status: 400,
                headers: responseHeaders("text/plain; charset=utf-8"),
              });
            }
            if (body.paused !== undefined && typeof body.paused !== "boolean") {
              return new Response("paused must be a boolean\n", {
                status: 400,
                headers: responseHeaders("text/plain; charset=utf-8"),
              });
            }
            const current = readControlFile(controlPath)
              ?? { paused: false, profile: profiles[0] ?? "default" };
            writeControlFile(controlPath, {
              paused: (body.paused as boolean | undefined) ?? current.paused,
              profile: (body.profile as string | undefined) ?? current.profile,
            });
            return new Response(null, {
              status: 204,
              headers: responseHeaders("text/plain; charset=utf-8"),
            });
          }
          if (request.method !== "GET") {
            return new Response("Method not allowed\n", {
              status: 405,
              headers: responseHeaders("text/plain; charset=utf-8", { Allow: "GET" }),
            });
          }
          if (url.pathname === "/") return staticResponse("index.html", "text/html; charset=utf-8");
          if (url.pathname === "/styles.css") return staticResponse("styles.css", "text/css; charset=utf-8");
          if (url.pathname === "/app.js") return staticResponse("app.js", "text/javascript; charset=utf-8");
          if (url.pathname === "/refresh-scheduler.js") {
            return staticResponse("refresh-scheduler.js", "text/javascript; charset=utf-8");
          }
          if (url.pathname === "/view-model.js") {
            return staticResponse("view-model.js", "text/javascript; charset=utf-8");
          }
          if (url.pathname === "/events") {
            return sseResponse(request, database, cleanups, pollIntervalMs, keepaliveIntervalMs, logger);
          }
          if (url.pathname === "/api/control") {
            return Response.json(readControlState(database, profiles), {
              headers: responseHeaders("application/json; charset=utf-8"),
            });
          }
          if (url.pathname === "/api/devices") {
            return Response.json(readDevices(database), {
              headers: responseHeaders("application/json; charset=utf-8"),
            });
          }
          if (url.pathname === "/api/summary") {
            const range = parseViewerRange(url.searchParams.get("range") ?? "live", now());
            const device = url.searchParams.get("device") ?? undefined;
            // Absent means *every* profile, never one of them. The analysis default is `default`,
            // which is right for a report naming its scope and wrong for a dashboard: it would
            // silently drop everything typed under any other activity label while the totals still
            // read as the whole picture.
            const profile = url.searchParams.get("profile") ?? ALL_PROFILES;
            const metrics = calculateMetrics(database, meta, range, {
              profile,
              ...(device ? { device } : {}),
            });
            metrics.positionLoad = orderForPositionSpace(
              metrics.header.positionSpace,
              metrics.positionLoad,
            );
            const correctionLayer = buildCorrectionLayer(
              metrics,
              parseCorrectionFilter(url.searchParams.get("corrections")),
            );
            return Response.json({ ...metrics, correctionLayer }, {
              headers: responseHeaders("application/json; charset=utf-8"),
            });
          }
          return new Response("Not found\n", {
            status: 404,
            headers: responseHeaders("text/plain; charset=utf-8"),
          });
        } catch (error) {
          logger.error("viewer request failed", error);
          return new Response("Internal server error\n", {
            status: 500,
            headers: responseHeaders("text/plain; charset=utf-8"),
          });
        }
      },
      error(error) {
        logger.error("viewer server error", error);
        return new Response("Internal server error\n", {
          status: 500,
          headers: responseHeaders("text/plain; charset=utf-8"),
        });
      },
    });
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    server,
    database,
    url: `http://${HOST}:${server.port}`,
    activeSsePollers: () => cleanups.size,
    stop() {
      for (const cleanup of [...cleanups]) cleanup();
      server.stop(true);
      database.close();
    },
  };
}

export function runViewer(args: string[]): ViewerApp {
  const parsed = parseViewerArgs(args);
  const app = createViewerServer(parsed);
  console.log(`viewer listening on ${app.url}`);
  return app;
}

if (import.meta.main) {
  try {
    runViewer(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`viewer: ${message}`);
    process.exitCode = 1;
  }
}
