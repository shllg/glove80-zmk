#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openKeylabDatabase } from "../../analysis/src/db";
import { loadAnalysisMeta, type AnalysisMeta } from "../../analysis/src/meta";
import {
  ALL_PROFILES,
  calculateMetrics,
  parseLabRange,
  type AnalysisMetrics,
  type CorrectedPosition,
} from "../../analysis/src/metrics";
import { listCorpora } from "../../trainer/src/corpus";
import { benchmarkHistory, sessionDetail, sessionHistory } from "../../trainer/src/history";
import { defaultTrainerPath, openTrainerStore, type TrainerStore } from "../../trainer/src/store";
import { buildWeaknessModel } from "../../trainer/src/weakness";
import {
  readControlFile,
  readControlState,
  updateManualControl,
  type ControlState,
} from "./control";
import { orderForPositionSpace } from "./geometry";
import { buildHealth, systemdServiceState, type ServiceState } from "./health";
import { keymapArtifact, keymapStatus } from "./keymap";
import { createTrainingManager, TrainingRequestError, type TrainingManager } from "./training";

const HOST = "127.0.0.1";
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const PUBLIC_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

/** Mirrors `crates/keylab/src/config.rs`'s `Default::default` so the two never drift apart. */
export const DEFAULT_PROFILES = [
  "default", "training-de", "training-en", "gaming", "training-code",
] as const;

export interface LabArgs {
  dbPath: string;
  trainerPath?: string;
  port: number;
  host: typeof HOST;
  profiles?: string[];
  controlPath?: string;
  repoRoot?: string;
}

export interface LabServerOptions extends LabArgs {
  metaPath?: string;
  now?: () => number;
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
  profileConfirmMs?: number;
  profileConfirmPollMs?: number;
  confirmProfileLease?: (leaseId: string, profile: string) => boolean | Promise<boolean>;
  serviceState?: () => ServiceState;
  logger?: Pick<Console, "log" | "error">;
}

export interface LabApp {
  server: ReturnType<typeof Bun.serve>;
  database: Database | null;
  store: TrainerStore;
  url: string;
  activeSsePollers(): number;
  activeTrainingSessions(): number;
  stop(): void;
}

interface UpdatedAtRow {
  updated_at: number;
}

export function parseLabArgs(args: string[]): LabArgs {
  const parsed: LabArgs = {
    dbPath: join(homedir(), ".local/share/glove80-lab/keylab.db"),
    trainerPath: defaultTrainerPath(),
    port: 4123,
    host: HOST,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
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
    } else if (argument === "--trainer") {
      const value = args[index + 1];
      if (!value) throw new Error("--trainer requires a path");
      parsed.trainerPath = resolve(value);
      index += 1;
    } else if (argument === "--repo") {
      const value = args[index + 1];
      if (!value) throw new Error("--repo requires a path");
      parsed.repoRoot = resolve(value);
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

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json() as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingRequestError("JSON body must be an object");
  }
  return value as Record<string, unknown>;
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

export interface LabDevice {
  id: number;
  name: string;
  positionSpace: string | null;
  firstTs: number;
  keystrokes: number;
  /** Tier B windows. A device with none has no heatmap to draw, however many keystrokes it holds. */
  tierBWindows: number;
  keymapHash: string | null;
}

/**
 * Devices are named by their evdev name, and one keyboard can hold several rows: an older daemon
 * minted a fresh `device_id` per reconnect, and those rows keep their data. Two entries reading
 * `Evsieve Virtual Device · glove80` are indistinguishable in a menu, so each carries what
 * separates it — its id, when it was first seen, and how much it actually holds.
 */
function readDevices(database: Database): LabDevice[] {
  return (database.query(`
    SELECT d.id, d.name, d.keymap_kind AS positionSpace, d.keymap_hash AS keymapHash,
           d.first_ts AS firstTs,
           (SELECT COALESCE(SUM(b.keystrokes), 0) FROM bucket b WHERE b.device_id = d.id)
             AS keystrokes,
           (SELECT COUNT(*) FROM key_window kw WHERE kw.device_id = d.id) AS tierBWindows
    FROM device d
    WHERE EXISTS (SELECT 1 FROM bucket b WHERE b.device_id = d.id)
       OR EXISTS (SELECT 1 FROM key_window kw WHERE kw.device_id = d.id)
    ORDER BY d.id
  `).all() as LabDevice[]).map((device) => ({
    id: Number(device.id),
    name: device.name,
    positionSpace: device.positionSpace ?? null,
    firstTs: Number(device.firstTs),
    keystrokes: Number(device.keystrokes),
    tierBWindows: Number(device.tierBWindows),
    keymapHash: device.keymapHash ?? null,
  }));
}

function readUpdatedAt(database: Database): number | null {
  const row = database.query("SELECT updated_at FROM live_snapshot WHERE id = 1").get() as UpdatedAtRow | null;
  return row ? Number(row.updated_at) : null;
}

function sseResponse(
  request: Request,
  database: () => Database | null,
  cleanups: Set<() => void>,
  pollIntervalMs: number,
  keepaliveIntervalMs: number,
  logger: Pick<Console, "error">,
): Response {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let lastUpdatedAt = database() ? readUpdatedAt(database() as Database) : null;
      let closed = false;
      const enqueue = (value: string) => {
        if (!closed) controller.enqueue(encoder.encode(value));
      };
      enqueue(": connected\n\n");

      const pollTimer = setInterval(() => {
        try {
          const current = database();
          const updatedAt = current ? readUpdatedAt(current) : null;
          if (updatedAt !== null && updatedAt !== lastUpdatedAt) {
            lastUpdatedAt = updatedAt;
            enqueue(`event: snapshot\ndata: ${JSON.stringify({ updatedAt })}\n\n`);
          }
        } catch (error) {
          logger.error("Lab SSE poll failed", error);
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

export function createLabServer(options: LabServerOptions): LabApp {
  if (options.host !== HOST) {
    throw new Error(`Lab must bind ${HOST}`);
  }
  const logger = options.logger ?? console;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const profiles = options.profiles ?? [...DEFAULT_PROFILES];
  const controlPath = options.controlPath ?? join(dirname(options.dbPath), "control.json");
  const pausePath = join(dirname(options.dbPath), "PAUSED");
  const repoRoot = options.repoRoot
    ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const metaPath = options.metaPath ?? join(repoRoot, "out/keymap-meta.json");
  const store = openTrainerStore(options.trainerPath ?? defaultTrainerPath());
  let database: Database | null = null;
  let databaseError: string | null = null;
  let meta: AnalysisMeta | null = null;

  const connectKeylab = (): Database | null => {
    if (database !== null) return database;
    try {
      database = openKeylabDatabase(options.dbPath);
      databaseError = null;
      try {
        meta = loadAnalysisMeta(database, metaPath);
      } catch (error) {
        // Database compatibility and generated-metadata compatibility are separate health axes.
        // Insights need both, while daemon state and history remain useful with either one absent.
        meta = null;
        logger.error("lab keymap metadata unavailable", error);
      }
      return database;
    } catch (error) {
      databaseError = error instanceof Error ? error.message : String(error);
      database = null;
      return null;
    }
  };

  const analysisMeta = (): AnalysisMeta => {
    if (meta !== null) return meta;
    meta = loadAnalysisMeta(connectKeylab(), metaPath);
    return meta;
  };

  connectKeylab();
  try {
    if (meta === null) meta = loadAnalysisMeta(null, metaPath);
  } catch {
    // The keymap page reports the precise artifact error. Other independent pages still start.
  }

  const training: TrainingManager = createTrainingManager({ store, controlPath, now });
  const serviceState = options.serviceState ?? systemdServiceState;
  try {
    // Opening the trainer database is the only required persistent dependency. Keylab and generated
    // artifacts are intentionally best-effort so the suite remains the one place to diagnose them.
  } catch (error) {
    store.close();
    throw error;
  }
  const cleanups = new Set<() => void>();
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? 15_000;
  const profileConfirmMs = options.profileConfirmMs ?? 3_000;
  const profileConfirmPollMs = options.profileConfirmPollMs ?? 50;

  const textResponse = (body: string, status: number, extra: HeadersInit = {}) => new Response(
    `${body}\n`,
    { status, headers: responseHeaders("text/plain; charset=utf-8", extra) },
  );
  const jsonResponse = (value: unknown, status = 200) => Response.json(value, {
    status,
    headers: responseHeaders("application/json; charset=utf-8"),
  });

  const currentHealth = () => buildHealth({
    database: connectKeylab(),
    databaseError,
    profiles,
    controlPath,
    pausePath,
    nowTs: now(),
    service: serviceState(),
  });

  const currentMetrics = () => {
    const current = connectKeylab();
    if (current === null) return undefined;
    return calculateMetrics(current, analysisMeta(), parseLabRange("all", now()), { profile: "*" });
  };

  const pollForLease = async (leaseId: string, profile: string): Promise<boolean> => {
    const deadline = Date.now() + profileConfirmMs;
    do {
      const state = readControlState(connectKeylab(), profiles);
      if (state.profile === profile && state.profile_lease?.id === leaseId) return true;
      if (Date.now() >= deadline) return false;
      await Bun.sleep(profileConfirmPollMs);
    } while (true);
  };
  const confirmLease = async (leaseId: string, profile: string) => (
    options.confirmProfileLease
      ? await options.confirmProfileLease(leaseId, profile)
      : pollForLease(leaseId, profile)
  );

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: HOST,
      port: options.port,
      async fetch(request) {
        try {
          const url = new URL(request.url);
          if (url.hostname !== HOST && url.hostname !== "localhost") {
            return textResponse("Misdirected request", 421);
          }
          const postRoutes = new Set([
            "/api/control",
            "/api/training/start",
            "/api/training/heartbeat",
            "/api/training/finish",
            "/api/training/cancel",
          ]);
          if (request.method === "POST" && !postRoutes.has(url.pathname)) {
            return textResponse("Method not allowed", 405, { Allow: "GET" });
          }
          if (request.method === "POST") {
            const origin = request.headers.get("origin");
            if (origin !== null && !isSameServerOrigin(origin, server.port)) {
              return textResponse("Forbidden", 403);
            }
            if (request.headers.get("content-type") !== "application/json") {
              return textResponse("Unsupported media type", 415);
            }
          } else if (request.method !== "GET") {
            return textResponse("Method not allowed", 405, { Allow: "GET, POST" });
          }

          if (url.pathname === "/api/control" && request.method === "POST") {
            const body = await jsonObject(request);
            const daemonState = readControlState(connectKeylab(), profiles);
            if (body.profile !== undefined
              && (typeof body.profile !== "string" || !daemonState.profiles.includes(body.profile))) {
              return textResponse("Unknown profile", 400);
            }
            if (body.paused !== undefined && typeof body.paused !== "boolean") {
              return textResponse("paused must be a boolean", 400);
            }
            const current = readControlFile(controlPath)
              ?? { paused: false, profile: daemonState.profile };
            updateManualControl(controlPath, current, {
              ...(body.paused !== undefined ? { paused: body.paused as boolean } : {}),
              ...(body.profile !== undefined ? { profile: body.profile as string } : {}),
            }, now());
            return new Response(null, { status: 204, headers: responseHeaders("text/plain; charset=utf-8") });
          }

          if (url.pathname === "/api/training/start" && request.method === "POST") {
            const body = await jsonObject(request);
            const health = currentHealth();
            const captureAvailable = health.capture === "fresh" && health.service === "active";
            if (body.mode === "drill"
              && body.family === "mechanic"
              && (!captureAvailable || health.paused)) {
              throw new TrainingRequestError(
                "Mechanic drills require active, unpaused keylab capture",
                409,
                "capture-required",
              );
            }
            // Benchmarks are fixed corpora and deliberately have no dependency on telemetry or
            // generated keymap metadata. Only drills need those inputs.
            const drill = body.mode === "drill";
            const metrics = drill ? currentMetrics() : undefined;
            const daemonControl = readControlState(connectKeylab(), profiles);
            return jsonResponse(await training.start(body, {
              ...(drill ? { meta: analysisMeta() } : {}),
              ...(metrics ? { metrics } : {}),
              captureAvailable,
              control: { ...daemonControl, paused: health.paused },
              allowTrainerOnly: body.trainerOnly === true,
              confirmLease,
            }));
          }
          if (url.pathname === "/api/training/heartbeat" && request.method === "POST") {
            const body = await jsonObject(request);
            return jsonResponse(training.heartbeat(body.token));
          }
          if (url.pathname === "/api/training/finish" && request.method === "POST") {
            return jsonResponse(training.finish(await jsonObject(request)));
          }
          if (url.pathname === "/api/training/cancel" && request.method === "POST") {
            const body = await jsonObject(request);
            return jsonResponse({ cancelled: training.cancel(body.token) });
          }

          if (request.method === "POST") return textResponse("Not found", 404);

          if (["/", "/insights", "/train", "/history", "/keymap"].includes(url.pathname)) {
            return staticResponse("index.html", "text/html; charset=utf-8");
          }
          if (url.pathname === "/styles.css") return staticResponse("styles.css", "text/css; charset=utf-8");
          if (url.pathname === "/app.js") return staticResponse("app.js", "text/javascript; charset=utf-8");
          if (url.pathname === "/refresh-scheduler.js") {
            return staticResponse("refresh-scheduler.js", "text/javascript; charset=utf-8");
          }
          if (url.pathname === "/view-model.js") {
            return staticResponse("view-model.js", "text/javascript; charset=utf-8");
          }
          if (url.pathname === "/typing-session.js") {
            return new Response(readFileSync(join(repoRoot, "packages/trainer/src/typing-session.js")), {
              headers: responseHeaders("text/javascript; charset=utf-8"),
            });
          }
          if (url.pathname === "/events") {
            return sseResponse(request, connectKeylab, cleanups, pollIntervalMs, keepaliveIntervalMs, logger);
          }
          if (url.pathname === "/api/health") {
            return jsonResponse(currentHealth());
          }
          if (url.pathname === "/api/control") {
            return jsonResponse(readControlState(connectKeylab(), profiles));
          }
          if (url.pathname === "/api/devices") {
            const current = connectKeylab();
            return jsonResponse(current ? readDevices(current) : []);
          }
          if (url.pathname === "/api/summary") {
            const current = connectKeylab();
            if (current === null) return jsonResponse({ error: databaseError ?? "keylab unavailable" }, 503);
            const range = parseLabRange(url.searchParams.get("range") ?? "live", now());
            const device = url.searchParams.get("device") ?? undefined;
            // Absent means *every* profile, never one of them. The analysis default is `default`,
            // which is right for a report naming its scope and wrong for a dashboard: it would
            // silently drop everything typed under any other activity label while the totals still
            // read as the whole picture.
            const profile = url.searchParams.get("profile") ?? ALL_PROFILES;
            const metrics = calculateMetrics(current, analysisMeta(), range, {
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
            return jsonResponse({ ...metrics, correctionLayer });
          }
          if (url.pathname === "/api/keymap") {
            return jsonResponse(keymapStatus(repoRoot, connectKeylab()));
          }
          if (url.pathname === "/assets/keymap.svg" || url.pathname === "/assets/keymap.pdf") {
            const kind = url.pathname.endsWith(".svg") ? "svg" : "pdf";
            const artifact = keymapArtifact(repoRoot, kind);
            if (artifact === null) return textResponse("Artifact not found", 404);
            return new Response(artifact as BodyInit, {
              headers: responseHeaders(kind === "svg" ? "image/svg+xml" : "application/pdf"),
            });
          }
          if (url.pathname === "/api/training/corpora") {
            return jsonResponse(listCorpora().map(({ id, version, language, family }) => ({
              id, version, language, family,
            })));
          }
          if (url.pathname === "/api/training/weakness") {
            return jsonResponse(buildWeaknessModel(store.database, analysisMeta(), currentMetrics()));
          }
          if (url.pathname === "/api/training/history") {
            const mode = url.searchParams.get("mode");
            const language = url.searchParams.get("language") ?? undefined;
            if (mode !== null && mode !== "benchmark" && mode !== "drill") {
              return textResponse("mode must be benchmark or drill", 400);
            }
            return jsonResponse({
              sessions: sessionHistory(store, {
                ...(mode ? { mode } : {}),
                ...(language ? { language } : {}),
              }),
              benchmark: benchmarkHistory(store),
            });
          }
          const detailMatch = /^\/api\/training\/history\/(\d+)$/.exec(url.pathname);
          if (detailMatch) {
            const detail = sessionDetail(store, Number(detailMatch[1]));
            return detail ? jsonResponse(detail) : textResponse("Session not found", 404);
          }
          return textResponse("Not found", 404);
        } catch (error) {
          if (error instanceof TrainingRequestError) {
            return jsonResponse({ error: error.message, code: error.code }, error.status);
          }
          logger.error("lab request failed", error);
          const message = error instanceof SyntaxError ? "Malformed JSON" : "Internal server error";
          return textResponse(message, error instanceof SyntaxError ? 400 : 500);
        }
      },
      error(error) {
        logger.error("lab server error", error);
        return textResponse("Internal server error", 500);
      },
    });
  } catch (error) {
    training.close();
    store.close();
    (database as Database | null)?.close();
    throw error;
  }

  return {
    server,
    get database() { return database; },
    store,
    url: `http://${HOST}:${server.port}`,
    activeSsePollers: () => cleanups.size,
    activeTrainingSessions: () => training.activeCount(),
    stop() {
      for (const cleanup of [...cleanups]) cleanup();
      training.close();
      server.stop(true);
      database?.close();
      store.close();
    },
  };
}

export function runLab(args: string[]): LabApp {
  const parsed = parseLabArgs(args);
  const app = createLabServer(parsed);
  console.log(app.url);
  return app;
}

if (import.meta.main) {
  try {
    runLab(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`lab: ${message}`);
    process.exitCode = 1;
  }
}
