#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openKeylabDatabase } from "@glove80/analysis/db";
import { loadAnalysisMeta } from "@glove80/analysis/meta";
import { calculateMetrics, parseSince } from "@glove80/analysis/metrics";
import { generateBenchmark, listCorpora } from "./corpus";
import {
  generateBigramDrill,
  generateLanguageDrill,
  generateMechanicDrill,
  generatePositionDrill,
} from "./drills";
import { rollingMedian, scoreSession } from "./scoring";
import { defaultTrainerPath, openTrainerStore, type KeystrokeRecord, type TrainerStore } from "./store";
import { buildWeaknessModel } from "./weakness";

const HOST = "127.0.0.1";
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const PUBLIC_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../public");

export interface TrainerServerOptions {
  port: number;
  host?: typeof HOST;
  trainerPath?: string;
  keylabPath?: string;
  metaPath?: string;
  now?: () => number;
  logger?: Pick<Console, "log" | "error">;
}

export interface TrainerApp {
  server: ReturnType<typeof Bun.serve>;
  store: TrainerStore;
  url: string;
  stop(): void;
}

function responseHeaders(contentType: string): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", contentType);
  return headers;
}

function textResponse(body: string, status: number): Response {
  return new Response(`${body}\n`, { status, headers: responseHeaders("text/plain; charset=utf-8") });
}

function staticResponse(fileName: string, contentType: string): Response {
  return new Response(readFileSync(join(PUBLIC_DIRECTORY, fileName)), {
    headers: responseHeaders(contentType),
  });
}

interface StartRequest {
  mode?: unknown;
  corpusId?: unknown;
  family?: unknown;
  language?: unknown;
  seed?: unknown;
  wordCount?: unknown;
  deviceLabel?: unknown;
}

interface FinishRequest {
  sessionId?: unknown;
  keystrokes?: unknown;
}

function parseKeystrokes(value: unknown): KeystrokeRecord[] {
  if (!Array.isArray(value)) throw new Error("keystrokes must be an array");
  return value.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    if (typeof record.code !== "string" || typeof record.tsMs !== "number") {
      throw new Error(`keystroke ${index} is missing code or tsMs`);
    }
    return {
      seq: index,
      tsMs: Math.round(record.tsMs),
      code: record.code,
      expectedCode: typeof record.expectedCode === "string" ? record.expectedCode : null,
      correct: record.correct === true,
    };
  });
}

/**
 * Reads keylab read-only. The trainer never writes to keylab's database: the two instruments
 * measure different things and must not be able to corrupt each other.
 */
function readKeylab(keylabPath: string, metaPath: string | undefined, nowTs: number) {
  const database = openKeylabDatabase(keylabPath);
  try {
    const meta = loadAnalysisMeta(database, metaPath);
    // The trainer sets its own keylab profile while it runs, so pooling every profile is right
    // here: the weakness model wants real-use friction, not just what happened during practice.
    const metrics = calculateMetrics(database, meta, parseSince("all", nowTs), { profile: "*" });
    return { meta, metrics };
  } finally {
    database.close();
  }
}

export function createTrainerServer(options: TrainerServerOptions): TrainerApp {
  const host = options.host ?? HOST;
  if (host !== HOST) throw new Error(`Trainer must bind ${HOST}`);
  const logger = options.logger ?? console;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const store = openTrainerStore(options.trainerPath ?? defaultTrainerPath());
  const keylabPath = options.keylabPath
    ?? join(homedir(), ".local/share/glove80-lab/keylab.db");

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
          if (request.method === "POST") {
            // Same CSRF guard as the viewer: a localhost server otherwise accepts simple
            // cross-origin POSTs from any page the browser has open.
            const origin = request.headers.get("origin");
            if (origin !== null && origin !== `http://${HOST}:${server.port}`) {
              return textResponse("Forbidden", 403);
            }
            if (request.headers.get("content-type") !== "application/json") {
              return textResponse("Unsupported media type", 415);
            }
          } else if (request.method !== "GET") {
            return textResponse("Method not allowed", 405);
          }

          if (url.pathname === "/") return staticResponse("index.html", "text/html; charset=utf-8");
          if (url.pathname === "/styles.css") return staticResponse("styles.css", "text/css; charset=utf-8");
          if (url.pathname === "/app.js") return staticResponse("app.js", "text/javascript; charset=utf-8");

          if (url.pathname === "/api/corpora" && request.method === "GET") {
            return Response.json(
              listCorpora().map(({ id, version, language, family }) => ({
                id, version, language, family,
              })),
              { headers: responseHeaders("application/json; charset=utf-8") },
            );
          }

          if (url.pathname === "/api/weakness" && request.method === "GET") {
            const { meta, metrics } = readKeylab(keylabPath, options.metaPath, now());
            return Response.json(
              buildWeaknessModel(store.database, meta, metrics),
              { headers: responseHeaders("application/json; charset=utf-8") },
            );
          }

          if (url.pathname === "/api/history" && request.method === "GET") {
            return Response.json(benchmarkHistory(store), {
              headers: responseHeaders("application/json; charset=utf-8"),
            });
          }

          if (url.pathname === "/api/session/start" && request.method === "POST") {
            const body = (await request.json()) as StartRequest;
            return startSession(store, body, keylabPath, options.metaPath, now());
          }

          if (url.pathname === "/api/session/finish" && request.method === "POST") {
            const body = (await request.json()) as FinishRequest;
            const sessionId = Number(body.sessionId);
            if (!Number.isInteger(sessionId)) return textResponse("sessionId is required", 400);
            const keystrokes = parseKeystrokes(body.keystrokes);
            store.recordKeystrokes(sessionId, keystrokes);
            store.finishSession(sessionId, now());
            return Response.json(scoreSession(keystrokes), {
              headers: responseHeaders("application/json; charset=utf-8"),
            });
          }

          return textResponse("Not found", 404);
        } catch (error) {
          logger.error("trainer request failed", error);
          const message = error instanceof Error ? error.message : "Internal server error";
          return textResponse(message, 500);
        }
      },
      error(error) {
        logger.error("trainer server error", error);
        return textResponse("Internal server error", 500);
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }

  return {
    server,
    store,
    url: `http://${HOST}:${server.port}`,
    stop() {
      server.stop(true);
      store.close();
    },
  };
}

function startSession(
  store: TrainerStore,
  body: StartRequest,
  keylabPath: string,
  metaPath: string | undefined,
  nowTs: number,
): Response {
  const mode = body.mode === "drill" ? "drill" : "benchmark";
  const seed = Number.isInteger(body.seed)
    ? Number(body.seed)
    : Math.floor(Math.random() * 0xffffffff);
  const deviceLabel = typeof body.deviceLabel === "string" ? body.deviceLabel : "unknown";
  const language = typeof body.language === "string" ? body.language : "en";

  let text: string;
  let corpusId: string;
  let corpusVersion: string;
  let resolvedLanguage = language;
  let rationale: string | null = null;
  let steps: unknown = undefined;

  if (mode === "benchmark") {
    const generated = generateBenchmark(
      typeof body.corpusId === "string" ? body.corpusId : (language === "de" ? "de-common" : "en-common"),
      seed,
      Number.isInteger(body.wordCount) ? Number(body.wordCount) : 50,
    );
    text = generated.text;
    corpusId = generated.corpusId;
    corpusVersion = generated.corpusVersion;
    resolvedLanguage = generated.language;
  } else {
    const { meta, metrics } = readKeylab(keylabPath, metaPath, nowTs);
    const weakness = buildWeaknessModel(store.database, meta, metrics);
    const family = body.family === "bigram" || body.family === "mechanic" || body.family === "language"
      ? body.family
      : "position";
    const drill = family === "bigram"
      ? generateBigramDrill(weakness, meta, seed)
      : family === "mechanic"
        ? generateMechanicDrill(weakness, seed)
        : family === "language"
          ? generateLanguageDrill(seed, { language })
          : generatePositionDrill(weakness, seed, { language });
    text = drill.text;
    corpusId = drill.corpusId;
    corpusVersion = drill.corpusVersion;
    resolvedLanguage = drill.language;
    rationale = drill.rationale;
    steps = (drill as { steps?: unknown }).steps;
  }

  const sessionId = store.startSession({
    startedTs: nowTs,
    mode,
    language: resolvedLanguage,
    corpusId,
    corpusVersion,
    seed,
    deviceLabel,
    keylabProfile: mode === "benchmark"
      ? (resolvedLanguage === "de" ? "training-de" : "training-en")
      : null,
  });

  return Response.json(
    { sessionId, mode, text, corpusId, corpusVersion, seed, language: resolvedLanguage, rationale, steps },
    { headers: responseHeaders("application/json; charset=utf-8") },
  );
}

export interface BenchmarkPoint {
  sessionId: number;
  startedTs: number;
  language: string;
  corpusId: string;
  corpusVersion: string;
  wpm: number;
  accuracy: number;
  unattributedCharacters: number;
}

export interface BenchmarkHistory {
  points: BenchmarkPoint[];
  /** Per language, in run order, so a German trend is only ever compared to its own history. */
  rollingMedianWpm: Record<string, number[]>;
}

export function benchmarkHistory(store: TrainerStore): BenchmarkHistory {
  const points: BenchmarkPoint[] = [];
  for (const session of store.sessions("benchmark")) {
    if (session.endedTs === null) continue;
    const rows = store.database
      .query("SELECT seq, ts_ms, code, expected_code, correct FROM keystroke WHERE session_id = ? ORDER BY seq")
      .all(session.id) as Array<Record<string, unknown>>;
    const score = scoreSession(rows.map((row) => ({
      seq: Number(row.seq),
      tsMs: Number(row.ts_ms),
      code: String(row.code),
      expectedCode: row.expected_code === null ? null : String(row.expected_code),
      correct: Number(row.correct) === 1,
    })));
    points.push({
      sessionId: session.id,
      startedTs: session.startedTs,
      language: session.language,
      corpusId: session.corpusId,
      corpusVersion: session.corpusVersion,
      wpm: score.wpm,
      accuracy: score.accuracy,
      unattributedCharacters: score.unattributedCharacters,
    });
  }
  const rollingMedianWpm: Record<string, number[]> = {};
  for (const language of new Set(points.map((point) => point.language))) {
    rollingMedianWpm[language] = rollingMedian(
      points.filter((point) => point.language === language).map((point) => point.wpm),
    );
  }
  return { points, rollingMedianWpm };
}

export function runTrainer(args: string[]): TrainerApp {
  let port = 4124;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--port") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("--port must be an integer from 1 through 65535");
      }
      port = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${args[index]}`);
    }
  }
  const app = createTrainerServer({ port });
  console.log(`trainer listening on ${app.url}`);
  return app;
}

if (import.meta.main) {
  try {
    runTrainer(Bun.argv.slice(2));
  } catch (error) {
    console.error(`trainer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
