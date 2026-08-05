#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openKeylabDatabase } from "@glove80/analysis/db";
import { loadAnalysisMeta } from "@glove80/analysis/meta";
import { calculateMetrics, parseViewerRange } from "@glove80/analysis/metrics";
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

export interface ViewerDevice {
  id: number;
  name: string;
  positionSpace: string | null;
}

function readDevices(database: Database): ViewerDevice[] {
  return (database.query(`
    SELECT d.id, d.name, d.keymap_kind AS positionSpace
    FROM device d
    WHERE EXISTS (SELECT 1 FROM bucket b WHERE b.device_id = d.id)
       OR EXISTS (SELECT 1 FROM key_window kw WHERE kw.device_id = d.id)
    ORDER BY d.id
  `).all() as ViewerDevice[]).map((device) => ({
    id: Number(device.id),
    name: device.name,
    positionSpace: device.positionSpace ?? null,
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
            const origin = request.headers.get("origin");
            if (origin !== null && origin !== `http://${HOST}:${server.port}`) {
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
            const metrics = calculateMetrics(database, meta, range, device ? { device } : {});
            metrics.positionLoad = orderForPositionSpace(
              metrics.header.positionSpace,
              metrics.positionLoad,
            );
            return Response.json(metrics, {
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
