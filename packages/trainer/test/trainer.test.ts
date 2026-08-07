import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openKeylabDatabase } from "../../analysis/src/db";
import { loadAnalysisMeta } from "../../analysis/src/meta";
import { calculateMetrics, parseSince } from "../../analysis/src/metrics";
import {
  createCorrectionFixture,
  createFixture,
  FIXTURE_NOW,
  type SeededFixture,
} from "../../analysis/test/fixture";
import {
  BENCHMARK_CORPUS_VERSION,
  corpus,
  generateBenchmark,
  listCorpora,
  sampleWords,
  seededRandom,
} from "../src/corpus";
import {
  generateBigramDrill,
  generateLanguageDrill,
  generateMechanicDrill,
  generatePositionDrill,
  sameFingerBigrams,
} from "../src/drills";
import {
  attributeCorrections,
  LATENCY_BUCKET_BOUNDARIES_MS,
  latencyBucket,
} from "../src/corrections";
import { codeIdentifiers, commitSubjects, proseWords } from "../src/ownMaterial";
import { COMPOSED_CODE, rollingMedian, scoreSession } from "../src/scoring";
import { benchmarkHistory, createTrainerServer, type TrainerApp } from "../src/server";
import {
  openTrainerStore,
  SUPPORTED_TRAINER_SCHEMA_VERSION,
  type TrainerStore,
} from "../src/store";
import { browserCodeToKeyName, buildWeaknessModel } from "../src/weakness";
import { applyInput, createTypingSession, noteKeydown } from "../public/typing-session.js";

const directories: string[] = [];
const stores: TrainerStore[] = [];
const fixtures: SeededFixture[] = [];
const apps: TrainerApp[] = [];
const silentLogger = { log() {}, error() {} };

afterEach(() => {
  for (const app of apps.splice(0)) app.stop();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by an app.stop() above.
    }
  }
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function trainerStore() {
  const directory = mkdtempSync(join(tmpdir(), "keylab-trainer-"));
  directories.push(directory);
  const store = openTrainerStore(join(directory, "data", "trainer.db"));
  stores.push(store);
  return { directory: join(directory, "data"), store };
}

function keylabContext() {
  const fixture = createFixture();
  fixtures.push(fixture);
  const database = openKeylabDatabase(fixture.path);
  const meta = loadAnalysisMeta(database, fixture.metaPath);
  const metrics = calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW));
  database.close();
  return { fixture, meta, metrics };
}

/** Tier C shaped so a rate and a count rank the keys differently. See the fixture's own comment. */
function correctionContext(options: { fingerOnly?: boolean } = {}) {
  const fixture = createCorrectionFixture(options);
  fixtures.push(fixture);
  const database = openKeylabDatabase(fixture.path);
  const meta = loadAnalysisMeta(database, fixture.metaPath);
  const metrics = calculateMetrics(database, meta, parseSince("all", FIXTURE_NOW));
  database.close();
  return { fixture, meta, metrics };
}

describe("trainer store", () => {
  test("creates a 0700 directory with the same backup markers as keylab", () => {
    const { directory } = trainerStore();
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(directory, "CACHEDIR.TAG"), "utf8"))
      .toStartWith("Signature: 8a477f597d28d172789f06886806bc55");
    expect(readFileSync(join(directory, "README.txt"), "utf8")).toContain("Exclude");
    expect(lstatSync(join(directory, "trainer.db")).mode & 0o777).toBe(0o600);
  });

  test("round-trips a session and its keystrokes", () => {
    const { store } = trainerStore();
    const id = store.startSession({
      startedTs: 1_000, mode: "benchmark", language: "en", corpusId: "en-common",
      corpusVersion: BENCHMARK_CORPUS_VERSION, seed: 42, deviceLabel: "test", keylabProfile: "training-en",
    });
    store.recordKeystrokes(id, [
      { seq: 0, tsMs: 0, code: "KeyA", expectedCode: "KeyA", correct: true },
      { seq: 1, tsMs: 120, code: "KeyB", expectedCode: "KeyC", correct: false },
    ]);
    store.finishSession(id, 1_060);

    const sessions = store.sessions("benchmark");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ mode: "benchmark", seed: 42, endedTs: 1_060 });
    const rows = store.database.query("SELECT COUNT(*) AS n FROM keystroke").get() as { n: number };
    expect(Number(rows.n)).toBe(2);
  });

  test("rejects a mode outside benchmark and drill", () => {
    const { store } = trainerStore();
    expect(() => store.startSession({
      startedTs: 1, mode: "freestyle" as "drill", language: "en", corpusId: "x",
      corpusVersion: "1", seed: 1, deviceLabel: "t", keylabProfile: null,
    })).toThrow();
  });
});

describe("benchmark corpora", () => {
  test("the same seed always produces the same text", () => {
    const first = generateBenchmark("en-common", 12_345, 20);
    const second = generateBenchmark("en-common", 12_345, 20);
    expect(first.text).toBe(second.text);
    expect(first.text.split(" ")).toHaveLength(20);
    expect(generateBenchmark("en-common", 12_346, 20).text).not.toBe(first.text);
  });

  test("a drill pool can never be used as a benchmark", () => {
    expect(() => generateBenchmark("en-drill", 1, 10))
      .toThrow("must never be used as a benchmark");
  });

  test("the German benchmark contains umlauts or it is not measuring German", () => {
    const german = corpus("de-common");
    const umlautWords = german.words.filter((word) => /[äöüß]/.test(word));
    expect(umlautWords.length).toBeGreaterThan(20);
  });

  test("benchmark and drill pools are disjoint so drills never practise the benchmark", () => {
    for (const language of ["en", "de"]) {
      const benchmark = new Set(
        listCorpora().find((c) => c.language === language && c.family === "benchmark")?.words ?? [],
      );
      const drill = listCorpora().find((c) => c.language === language && c.family === "drill");
      const overlap = (drill?.words ?? []).filter((word) => benchmark.has(word));
      expect(overlap).toEqual([]);
    }
  });

  test("every corpus carries a version tag", () => {
    for (const entry of listCorpora()) {
      expect(entry.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    }
  });

  test("the seeded generator is deterministic and stays in range", () => {
    const random = seededRandom(7);
    const values = Array.from({ length: 200 }, () => random());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(Array.from({ length: 200 }, seededRandom(7))).not.toEqual([]);
    expect(sampleWords(["a", "b", "c"], 5, 3)).toEqual(sampleWords(["a", "b", "c"], 5, 3));
  });
});

describe("scoring", () => {
  test("computes WPM over correct keystrokes and counts composed characters", () => {
    const score = scoreSession([
      { seq: 0, tsMs: 0, code: "KeyA", expectedCode: "KeyA", correct: true },
      { seq: 1, tsMs: 30_000, code: COMPOSED_CODE, expectedCode: null, correct: true },
      { seq: 2, tsMs: 60_000, code: "KeyB", expectedCode: "KeyB", correct: false },
    ]);
    expect(score.keystrokes).toBe(3);
    expect(score.correct).toBe(2);
    expect(score.elapsedMs).toBe(60_000);
    expect(score.wpm).toBeCloseTo(0.4, 6);
    expect(score.unattributedCharacters).toBe(1);
  });

  test("an empty session scores zero rather than dividing by zero", () => {
    expect(scoreSession([])).toMatchObject({ wpm: 0, accuracy: 0, elapsedMs: 0 });
  });

  test("the rolling median smooths seed noise without erasing a real change", () => {
    expect(rollingMedian([10, 90, 12, 11, 13], 5)).toEqual([10, 50, 12, 11.5, 12]);
    expect(rollingMedian([50, 50, 50, 80, 80, 80], 3)).toEqual([50, 50, 50, 50, 80, 80]);
  });
});

describe("weakness model", () => {
  test("bootstraps from keylab when there is no trainer history", () => {
    const { store } = trainerStore();
    const { meta, metrics } = keylabContext();
    const model = buildWeaknessModel(store.database, meta, metrics);
    expect(model.confidence).toBe("bootstrap");
    expect(model.sessionCount).toBe(0);
    expect(model.positions.length).toBeGreaterThan(0);
    expect(model.positions.every((position) => position.errorRate === null)).toBe(true);
    expect(model.positions.every((position) => position.sources.includes("keylab-tier-b"))).toBe(true);
  });

  test("switches to trainer-derived scoring once enough attempts exist", () => {
    const { store } = trainerStore();
    const { meta, metrics } = keylabContext();
    const id = store.startSession({
      startedTs: 1, mode: "drill", language: "en", corpusId: "en-drill",
      corpusVersion: "1", seed: 1, deviceLabel: "t", keylabProfile: null,
    });
    // 40 attempts on KEY_A, 30 of them wrong: unambiguously a measured weakness.
    store.recordKeystrokes(id, Array.from({ length: 40 }, (_, index) => ({
      seq: index,
      tsMs: index * 100,
      code: "KeyA",
      expectedCode: "KEY_A",
      correct: index >= 30,
    })));
    store.finishSession(id, 100);

    const model = buildWeaknessModel(store.database, meta, metrics);
    expect(model.confidence).toBe("trainer");
    expect(model.sessionCount).toBe(1);
    const a = model.positions.find((position) => position.label === "A");
    expect(a?.errorRate).toBeCloseTo(0.75, 6);
    expect(a?.sources).toContain("trainer");
  });

  test("surfaces the firmware mechanics no word list can reach", () => {
    const { store } = trainerStore();
    const { meta, metrics } = keylabContext();
    const model = buildWeaknessModel(store.database, meta, metrics);
    const kinds = model.mechanics.map((mechanic) => mechanic.kind);
    // The seeded keylab fixture carries a modifier-hold outlier and misfire counters.
    expect(kinds).toContain("lonely-mod");
    expect(model.mechanics.every((mechanic) => mechanic.score >= 0 && mechanic.score <= 1)).toBe(true);
  });

  test("Tier C entries carry their own confidence label", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext();
    const model = buildWeaknessModel(store.database, meta, metrics);
    // Real-use corrections are neither frequency nor measured error, so they get their own label
    // rather than being merged into a regime that means something else.
    expect(model.confidence).toBe("keylab-tier-c");
    const p = model.positions.find((position) => position.label === "P");
    expect(p?.sources).toContain("keylab-tier-c");
    expect(p?.sources).not.toContain("trainer");
    expect(p?.corrections).toBe(50);
    expect(p?.correctionRate).toBeCloseTo(0.5, 10);
    // P is corrected less often than V in absolute terms and far more often per press. Ranking it
    // first is the difference between "keys I use" and "keys I get wrong".
    expect(model.positions[0]?.label).toBe("P");
  });

  test("edits are weighted below fumbles", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext();
    const model = buildWeaknessModel(store.database, meta, metrics);
    const v = model.positions.find((position) => position.label === "V");
    const m = model.positions.find((position) => position.label === "M");
    // Same presses, same corrections. Only the latency bucket differs, and a deletion a second
    // after the last keystroke is a rewrite rather than a mistyped key.
    expect(v?.presses).toBe(m?.presses as number);
    expect(v?.corrections).toBe(m?.corrections as number);
    expect(v?.correctionRate).toBeCloseTo(0.06, 10);
    expect(m?.correctionRate).toBe(0);
    expect(v?.score).toBeGreaterThan(m?.score as number);
    // An editorial rewrite must not reach the transition list either.
    expect(model.correctedTransitions.map((entry) => entry.letters)).not.toContain("em");
  });

  test("a position with too few presses is no data rather than the worst key on the board", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext();
    const model = buildWeaknessModel(store.database, meta, metrics);
    const z = model.positions.find((position) => position.label === "Z");
    // 3 corrections in 4 presses is the highest raw rate in the fixture and four presses of data.
    expect(z).toMatchObject({ presses: 4, corrections: 3, correctionRate: null });
    expect(z?.sources).not.toContain("keylab-tier-c");
    expect(model.positions[0]?.label).not.toBe("Z");
  });

  test("degraded finger rows never produce position entries", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext({ fingerOnly: true });
    const model = buildWeaknessModel(store.database, meta, metrics);
    expect(metrics.correctionTax.context.byFinger.length).toBeGreaterThan(0);
    expect(metrics.correctionTax.context.byPosition).toEqual([]);
    // A finger triple identifies a motion and no key at all, so nothing may land on a position.
    expect(model.positions.every((position) => position.corrections === 0)).toBe(true);
    expect(model.positions.every((position) =>
      !position.sources.includes("keylab-tier-c"))).toBe(true);
    expect(model.confidence).toBe("bootstrap");
    // The motion still survives, as a transition that names fingers and no letters.
    const degraded = model.correctedTransitions.filter((entry) => entry.degraded);
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.every((entry) => entry.letters === null && entry.fingers !== null)).toBe(true);
  });

  test("maps browser physical keys onto keymap key names", () => {
    expect(browserCodeToKeyName("KeyA")).toBe("KEY_A");
    expect(browserCodeToKeyName("Digit4")).toBe("KEY_4");
    expect(browserCodeToKeyName("Space")).toBe("KEY_SPACE");
    expect(browserCodeToKeyName("IntlBackslash")).toBe("KEY_102ND");
    expect(browserCodeToKeyName("F13")).toBeNull();
  });
});

describe("drills", () => {
  test("every drill family generates deterministic, non-empty output", () => {
    const { store } = trainerStore();
    const { meta, metrics } = keylabContext();
    const weakness = buildWeaknessModel(store.database, meta, metrics);

    const position = generatePositionDrill(weakness, 99, { wordCount: 12 });
    expect(position.text.split(" ")).toHaveLength(12);
    expect(generatePositionDrill(weakness, 99, { wordCount: 12 }).text).toBe(position.text);
    expect(position.rationale).toContain("bootstrapped");

    const bigram = generateBigramDrill(weakness, meta, 99, { repetitions: 5 });
    expect(bigram.text.split(" ")).toHaveLength(5);

    const mechanic = generateMechanicDrill(weakness, 99);
    expect(mechanic.steps.length).toBeGreaterThan(0);
    expect(mechanic.rationale).toContain("Tier A");

    const language = generateLanguageDrill(99, { language: "de", wordCount: 8 });
    expect(language.text.split(" ")).toHaveLength(8);
    expect(language.rationale).toContain("eight keystrokes");
  });

  test("the German language drill is umlaut-dense because that is what it measures", () => {
    const drill = generateLanguageDrill(5, { language: "de", wordCount: 30 });
    const umlautWords = drill.text.split(" ").filter((word) => /[äöüß]/.test(word));
    expect(umlautWords.length).toBe(30);
  });

  test("no drill ever draws from a benchmark pool", () => {
    const { store } = trainerStore();
    const { meta, metrics } = keylabContext();
    const weakness = buildWeaknessModel(store.database, meta, metrics);
    const benchmarkWords = new Set(
      listCorpora().filter((c) => c.family === "benchmark").flatMap((c) => [...c.words]),
    );
    for (const drill of [
      generatePositionDrill(weakness, 1, { wordCount: 30 }),
      generatePositionDrill(weakness, 2, { language: "de", wordCount: 30 }),
      generateLanguageDrill(3, { language: "de", wordCount: 30 }),
      generateLanguageDrill(4, { language: "code", wordCount: 30 }),
    ]) {
      for (const word of drill.text.split(" ")) {
        expect(benchmarkWords.has(word)).toBe(false);
      }
    }
  });

  test("position drills weight toward corrected keys", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext();
    const weakness = buildWeaknessModel(store.database, meta, metrics);
    // The control is the same model with its ranking removed, so the only variable is the weighting.
    const unweighted = { ...weakness, positions: [] };
    const letters = (text: string, letter: string) =>
      [...text].filter((character) => character === letter).length;
    const drill = generatePositionDrill(weakness, 7, { wordCount: 200 });
    const flat = generatePositionDrill(unweighted, 7, { wordCount: 200 });
    expect(letters(drill.text, "p")).toBeGreaterThan(letters(flat.text, "p"));
    expect(drill.rationale).toContain("correct");
  });

  test("transition drills weight toward corrected transitions", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext();
    const weakness = buildWeaknessModel(store.database, meta, metrics);
    const drill = generateBigramDrill(weakness, meta, 11, { repetitions: 60 });
    const groups = (pair: string) =>
      drill.text.split(" ").filter((group) => group.startsWith(pair)).length;
    // "e v" preceded 60 fumbles and "w z" three, so the pool leans the same way.
    expect(groups("ev")).toBeGreaterThan(0);
    expect(groups("ev")).toBeGreaterThan(groups("wz"));
    expect(drill.rationale).toContain("corrections");
  });

  test("a corrected trigram never pulls a benchmark word into a drill", () => {
    const { store } = trainerStore();
    const { meta, metrics } = correctionContext();
    const weakness = buildWeaknessModel(store.database, meta, metrics);
    const benchmarkWords = new Set(
      listCorpora().filter((entry) => entry.family === "benchmark").flatMap((entry) => [...entry.words]),
    );
    const drillWords = new Set(corpus("en-drill").words);
    // Correction data may steer which drill words are picked; it may never widen where they come
    // from, or the benchmark would be measuring text the drills had just practised.
    for (const word of generatePositionDrill(weakness, 5, { wordCount: 60 }).text.split(" ")) {
      expect(drillWords.has(word)).toBe(true);
      expect(benchmarkWords.has(word)).toBe(false);
    }
    for (const group of generateBigramDrill(weakness, meta, 5, { repetitions: 20 }).text.split(" ")) {
      expect(benchmarkWords.has(group)).toBe(false);
    }
  });

  test("same-finger bigrams come out of the keymap, not a hard-coded list", () => {
    const { meta } = keylabContext();
    const pairs = sameFingerBigrams(meta);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((pair) => pair.length === 2)).toBe(true);
  });
});

describe("own-material corpus", () => {
  test("reads commit subjects from this repository", () => {
    const subjects = commitSubjects({ limit: 20 });
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.every((subject) => subject.length <= 120)).toBe(true);
  });

  test("returns an empty list rather than throwing outside a repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "keylab-not-a-repo-"));
    directories.push(directory);
    expect(commitSubjects({ repositoryPath: directory })).toEqual([]);
  });

  test("extracts multi-word identifiers only", () => {
    const identifiers = codeIdentifiers([
      join(import.meta.dir, "../src/weakness.ts"),
      join(import.meta.dir, "../src/store.ts"),
    ]);
    expect(identifiers).toContain("buildWeaknessModel");
    expect(identifiers.every((identifier) => identifier.length >= 6)).toBe(true);
    expect(identifiers).not.toContain("const");
  });

  test("builds a prose word pool from commit subjects", () => {
    const words = proseWords(["feat(keylab): add activity profiles", "docs: document both pauses"]);
    expect(words).toContain("keylab");
    expect(words).toContain("profiles");
    expect(words.every((word) => word.length >= 3)).toBe(true);
  });
});

describe("trainer server", () => {
  function startTrainer() {
    const directory = mkdtempSync(join(tmpdir(), "keylab-trainer-app-"));
    directories.push(directory);
    const fixture = createFixture();
    fixtures.push(fixture);
    const app = createTrainerServer({
      port: 0,
      trainerPath: join(directory, "data", "trainer.db"),
      keylabPath: fixture.path,
      metaPath: fixture.metaPath,
      now: () => FIXTURE_NOW,
      logger: silentLogger,
    });
    apps.push(app);
    return { app, fixture };
  }

  test("starts a benchmark session and returns reproducible text", async () => {
    const { app } = startTrainer();
    const response = await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", corpusId: "en-common", seed: 4, wordCount: 10 }),
    });
    expect(response.status).toBe(200);
    const started = await response.json();
    expect(started.text).toBe(generateBenchmark("en-common", 4, 10).text);
    expect(started.corpusVersion).toBe(BENCHMARK_CORPUS_VERSION);
    expect(started.sessionId).toBe(1);
  });

  test("accepts a session POST from the localhost spelling of its own origin", async () => {
    const { app } = startTrainer();
    const response = await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${new URL(app.url).port}`,
      },
      body: JSON.stringify({ mode: "benchmark", corpusId: "en-common", seed: 4, wordCount: 10 }),
    });
    expect(response.status).toBe(200);
  });

  test("rejects a cross-origin POST and a non-JSON body", async () => {
    const { app } = startTrainer();
    const foreign = await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const plain = await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "mode=benchmark",
    });
    expect(plain.status).toBe(415);
  });

  test("finishing a session scores it and files it under the benchmark trend", async () => {
    const { app } = startTrainer();
    const started = await (await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", corpusId: "en-common", seed: 4, wordCount: 4 }),
    })).json();

    const keystrokes = [...started.text].map((character: string, index: number) => ({
      tsMs: index * 200,
      code: /[a-z]/.test(character) ? `Key${character.toUpperCase()}` : "Space",
      expectedCode: /[a-z]/.test(character) ? `Key${character.toUpperCase()}` : "Space",
      correct: true,
    }));
    const finished = await fetch(`${app.url}/api/session/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: started.sessionId, keystrokes }),
    });
    expect(finished.status).toBe(200);
    const score = await finished.json();
    expect(score.keystrokes).toBe(keystrokes.length);
    expect(score.accuracy).toBe(1);

    const history = await (await fetch(`${app.url}/api/history`)).json();
    expect(history.points).toHaveLength(1);
    expect(history.rollingMedianWpm.en).toHaveLength(1);
  });

  test("a drill session is never plotted as a benchmark", async () => {
    const { app } = startTrainer();
    const started = await (await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "drill", family: "position", seed: 8 }),
    })).json();
    expect(started.mode).toBe("drill");
    expect(started.rationale).toBeTruthy();
    await fetch(`${app.url}/api/session/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: started.sessionId,
        keystrokes: [{ tsMs: 0, code: "KeyA", expectedCode: "KeyA", correct: true }],
      }),
    });
    const history = await (await fetch(`${app.url}/api/history`)).json();
    expect(history.points).toHaveLength(0);
  });

  test("records a composed character as unattributed rather than inventing a key", async () => {
    const { app } = startTrainer();
    const started = await (await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", corpusId: "de-common", seed: 2, wordCount: 3 }),
    })).json();
    const finished = await (await fetch(`${app.url}/api/session/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: started.sessionId,
        keystrokes: [
          { tsMs: 0, code: "KeyA", expectedCode: "KeyA", correct: true },
          { tsMs: 100, code: COMPOSED_CODE, expectedCode: null, correct: true },
        ],
      }),
    })).json();
    expect(finished.unattributedCharacters).toBe(1);
  });

  test("serves the weakness model over HTTP", async () => {
    const { app } = startTrainer();
    const model = await (await fetch(`${app.url}/api/weakness`)).json();
    expect(model.confidence).toBe("bootstrap");
    expect(Array.isArray(model.positions)).toBe(true);
  });

  test("serves the typing-session module the page imports", async () => {
    const { app } = startTrainer();
    const module = await fetch(`${app.url}/typing-session.js`);
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("text/javascript");
    expect(await module.text()).toContain("export function applyInput");
  });

  test("unknown routes and methods are refused", async () => {
    const { app } = startTrainer();
    expect((await fetch(`${app.url}/nope`)).status).toBe(404);
    expect((await fetch(`${app.url}/api/history`, { method: "DELETE" })).status).toBe(405);
  });

  test("rejects a malformed correction payload instead of coercing it", async () => {
    const { app } = startTrainer();
    const started = await (await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", corpusId: "en-common", seed: 4, wordCount: 4 }),
    })).json();

    for (const corrections of [
      "not-an-array",
      [{ tsMs: 10, charIndex: -1, runLength: 1 }],
      [{ tsMs: 10, charIndex: 0, runLength: 0 }],
      [{ tsMs: 10, charIndex: 1.5, runLength: 1 }],
      [{ charIndex: 0, runLength: 1 }],
    ]) {
      const response = await fetch(`${app.url}/api/session/finish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: started.sessionId, keystrokes: [], corrections }),
      });
      expect(response.status).toBe(500);
    }
    const stored = app.store.database
      .query("SELECT COUNT(*) AS n FROM correction").get() as { n: number };
    expect(Number(stored.n)).toBe(0);
  });

  test("a finished session returns its corrections, attributed to words", async () => {
    const { app } = startTrainer();
    const started = await (await fetch(`${app.url}/api/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "benchmark", corpusId: "en-common", seed: 4, wordCount: 4 }),
    })).json();
    const text: string = started.text;
    const secondWordStart = text.indexOf(" ") + 1;

    const keystrokes = [...text].map((character, index) => ({
      tsMs: index * 200,
      code: /[a-z]/.test(character) ? `Key${character.toUpperCase()}` : "Space",
      expectedCode: /[a-z]/.test(character) ? `Key${character.toUpperCase()}` : "Space",
      correct: true,
    }));
    const finished = await (await fetch(`${app.url}/api/session/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: started.sessionId,
        keystrokes,
        corrections: [
          { tsMs: 10_000, charIndex: 1, runLength: 1, expectedCode: "KeyX" },
          { tsMs: 10_100, charIndex: secondWordStart, runLength: 2, expectedCode: null },
        ],
      }),
    })).json();

    expect(finished.corrections.corrections).toBe(2);
    expect(finished.corrections.charactersRemoved).toBe(3);
    const attributed = finished.corrections.words as Array<{ word: string; corrections: number }>;
    const [firstWord, secondWord] = text.split(" ") as [string, string];
    expect(attributed.map((word) => word.word)).toContain(firstWord);
    expect(attributed.map((word) => word.word)).toContain(secondWord);
    expect(attributed.reduce((sum, word) => sum + word.corrections, 0)).toBe(2);
    // Corrections must never reach the score's denominators.
    expect(finished.keystrokes).toBe(keystrokes.length);
    expect(finished.accuracy).toBe(1);

    const history = await (await fetch(`${app.url}/api/history`)).json();
    expect(history.points[0].corrections.corrections).toBe(2);
    expect(history.points[0].corrections.charactersRemoved).toBe(3);
  });

  test("history is a benchmark-only trend even with drills present", () => {
    const { store } = trainerStore();
    for (const mode of ["benchmark", "drill"] as const) {
      const id = store.startSession({
        startedTs: 1, mode, language: "en", corpusId: "x", corpusVersion: "1",
        seed: 1, deviceLabel: "t", keylabProfile: null,
      });
      store.recordKeystrokes(id, [
        { seq: 0, tsMs: 0, code: "KeyA", expectedCode: "KeyA", correct: true },
        { seq: 1, tsMs: 60_000, code: "KeyB", expectedCode: "KeyB", correct: true },
      ]);
      store.finishSession(id, 2);
    }
    expect(benchmarkHistory(store).points).toHaveLength(1);
  });
});

describe("typing session capture", () => {
  function type(session: ReturnType<typeof createTypingSession>, typed: string, tsMs: number) {
    const character = typed.slice(-1);
    noteKeydown(session, { key: character, code: `Key${character.toUpperCase()}` });
    return applyInput(session, typed, tsMs);
  }

  function backspace(
    session: ReturnType<typeof createTypingSession>,
    typed: string,
    tsMs: number,
  ) {
    noteKeydown(session, { key: "Backspace", code: "Backspace" });
    return applyInput(session, typed, tsMs);
  }

  // The browser does not assign `seq` — the server does, on the way into the store.
  function scored(session: ReturnType<typeof createTypingSession>) {
    return scoreSession(session.keystrokes.map((keystroke, seq) => ({ ...keystroke, seq })));
  }

  test("a deletion does not count as a composed character", () => {
    const session = createTypingSession(1, "the cat");
    type(session, "t", 0);
    type(session, "tj", 100);
    expect(scored(session).unattributedCharacters).toBe(0);

    backspace(session, "t", 300);
    // The regression: before the fix the backspace produced a second keystroke row with no pending
    // code behind it, which scored as an input-method composition on every corrected session.
    expect(scored(session).unattributedCharacters).toBe(0);
  });

  test("a deletion does not change the keystroke count", () => {
    const session = createTypingSession(1, "the cat");
    type(session, "t", 0);
    type(session, "tj", 100);
    expect(session.keystrokes).toHaveLength(2);

    const outcome = backspace(session, "t", 300);
    expect(outcome.kind).toBe("correction");
    expect(session.keystrokes).toHaveLength(2);
    expect(session.corrections).toHaveLength(1);
    expect(session.corrections[0]).toMatchObject({
      charIndex: 1, runLength: 1, expectedCode: "KeyH",
    });
    // The deleted index is pending again, not wrong: the eye has not passed it a second time.
    expect(session.wrongIndices.has(1)).toBe(false);
  });

  test("a multi-character deletion records its run length", () => {
    const session = createTypingSession(1, "the cat");
    for (const [index, typed] of ["t", "th", "the", "the ", "the c"].entries()) {
      type(session, typed, index * 100);
    }
    expect(session.keystrokes).toHaveLength(5);

    // Ctrl+Backspace removes a whole word in one input event.
    const outcome = backspace(session, "the ", 900);
    expect(outcome.kind).toBe("correction");
    expect(session.corrections[0]).toMatchObject({ charIndex: 4, runLength: 1 });

    const wordwise = backspace(session, "t", 1_200);
    expect(wordwise.kind).toBe("correction");
    expect(session.corrections[1]).toMatchObject({ charIndex: 1, runLength: 3 });
    expect(session.keystrokes).toHaveLength(5);
  });

  test("a shrink with no Backspace behind it attributes no physical key", () => {
    const session = createTypingSession(1, "the cat");
    type(session, "t", 0);
    type(session, "th", 100);
    // An input method retracting its preview shrinks the field without any keydown.
    applyInput(session, "t", 200);
    expect(session.corrections[0]).toMatchObject({ charIndex: 1, runLength: 1, expectedCode: null });
  });

  test("a character composed with no keydown is still recorded as unattributed", () => {
    const session = createTypingSession(1, "äh");
    applyInput(session, "ä", 0);
    expect(session.keystrokes[0]).toMatchObject({ code: COMPOSED_CODE, expectedCode: null });
    expect(scored(session).unattributedCharacters).toBe(1);
  });

  test("completing the prompt reports completion exactly once", () => {
    const session = createTypingSession(1, "ab");
    expect(type(session, "a", 0).complete).toBe(false);
    expect(type(session, "ab", 100).complete).toBe(true);
    expect(backspace(session, "a", 200).complete).toBe(false);
  });
});

describe("correction storage", () => {
  test("records and reads back corrections", () => {
    const { store } = trainerStore();
    const id = store.startSession({
      startedTs: 1_000, mode: "drill", language: "en", corpusId: "en-drill",
      corpusVersion: "1", seed: 1, deviceLabel: "test", keylabProfile: null, text: "the cat",
    });
    store.recordCorrections(id, [
      { seq: 0, tsMs: 300, charIndex: 1, runLength: 1, expectedCode: "KeyH" },
      { seq: 1, tsMs: 900, charIndex: 4, runLength: 3, expectedCode: null },
    ]);
    store.recordKeystrokes(id, [
      { seq: 0, tsMs: 0, code: "KeyT", expectedCode: "KeyT", correct: true },
    ]);

    expect(store.corrections(id)).toEqual([
      { seq: 0, tsMs: 300, charIndex: 1, runLength: 1, expectedCode: "KeyH" },
      { seq: 1, tsMs: 900, charIndex: 4, runLength: 3, expectedCode: null },
    ]);
    // Corrections live in their own table so they can never move a scoring denominator.
    expect(store.keystrokes(id)).toHaveLength(1);
    expect(store.sessions()[0]?.text).toBe("the cat");
  });

  test("migrates a v1 trainer database in place", () => {
    const directory = mkdtempSync(join(tmpdir(), "keylab-trainer-v1-"));
    directories.push(directory);
    const path = join(directory, "trainer.db");
    const seed = new Database(path, { create: true });
    seed.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE session (
        id INTEGER PRIMARY KEY, started_ts INTEGER NOT NULL, ended_ts INTEGER,
        mode TEXT NOT NULL CHECK (mode IN ('benchmark', 'drill')), language TEXT NOT NULL,
        corpus_id TEXT NOT NULL, corpus_version TEXT NOT NULL, seed INTEGER NOT NULL,
        device_label TEXT NOT NULL, keylab_profile TEXT
      );
      CREATE TABLE keystroke (
        session_id INTEGER NOT NULL REFERENCES session(id), seq INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL, code TEXT NOT NULL, expected_code TEXT, correct INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');
      INSERT INTO session(id, started_ts, mode, language, corpus_id, corpus_version, seed,
                          device_label, keylab_profile)
      VALUES (1, 10, 'benchmark', 'en', 'en-common', '1', 7, 'old', NULL);
      INSERT INTO keystroke VALUES (1, 0, 0, 'KeyA', 'KeyA', 1);
    `);
    seed.close();

    const store = openTrainerStore(path);
    stores.push(store);
    const version = store.database
      .query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBe(SUPPORTED_TRAINER_SCHEMA_VERSION);
    // The history survives the migration; only its prompt text is unknowable after the fact.
    expect(store.sessions()).toHaveLength(1);
    expect(store.sessions()[0]?.text).toBeNull();
    expect(store.keystrokes(1)).toHaveLength(1);
    expect(store.corrections(1)).toEqual([]);
    store.recordCorrections(1, [
      { seq: 0, tsMs: 1, charIndex: 0, runLength: 1, expectedCode: null },
    ]);
    expect(store.corrections(1)).toHaveLength(1);
  });

  test("refuses a database written by a newer trainer rather than downgrading it", () => {
    const { store, directory } = trainerStore();
    store.database.query("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    store.close();
    expect(() => openTrainerStore(join(directory, "trainer.db")))
      .toThrow("Unsupported trainer schema_version");
  });
});

describe("correction attribution", () => {
  const KEYSTROKES = [
    { seq: 0, tsMs: 0, code: "KeyT", expectedCode: "KeyT", correct: true },
    { seq: 1, tsMs: 100, code: "KeyH", expectedCode: "KeyH", correct: true },
    { seq: 2, tsMs: 200, code: "KeyE", expectedCode: "KeyE", correct: true },
  ];

  test("the latency boundaries match keylab's Tier C exactly", () => {
    // Pinned against `latency_bucket` in `crates/keylab/src/encode.rs`, which carries the same
    // cases. Two instruments that disagree here mean different things by "fumble".
    expect(LATENCY_BUCKET_BOUNDARIES_MS).toEqual([150, 400, 1_000]);
    for (const [ms, bucket] of [
      [0, 0], [149, 0], [150, 1], [399, 1], [400, 2], [999, 2], [1_000, 3], [60_000, 3],
    ] as const) {
      expect(latencyBucket(ms)).toBe(bucket);
    }
  });

  test("attributes a correction to the word being typed", () => {
    const attribution = attributeCorrections(
      "the cat sat",
      [{ seq: 0, tsMs: 250, charIndex: 5, runLength: 1, expectedCode: "KeyA" }],
      KEYSTROKES,
    );
    expect(attribution.corrections).toBe(1);
    expect(attribution.charactersRemoved).toBe(1);
    expect(attribution.unattributed).toBe(0);
    expect(attribution.words).toEqual([
      { word: "cat", occurrences: 1, corrections: 1, correctionRate: 1, offsets: [{ offset: 1, count: 1 }] },
    ]);
    expect(attribution.transitions).toEqual([{ transition: " c", corrections: 1 }]);
  });

  test("attributes a correction at a word boundary to the preceding word", () => {
    const attribution = attributeCorrections(
      "the cat sat",
      // The space after "the": typed as part of finishing that word, so blaming "cat" would
      // attribute a mistake to text the hand had not reached.
      [{ seq: 0, tsMs: 250, charIndex: 3, runLength: 1, expectedCode: "Space" }],
      KEYSTROKES,
    );
    expect(attribution.words[0]?.word).toBe("the");
    expect(attribution.words[0]?.offsets).toEqual([{ offset: 3, count: 1 }]);
  });

  test("separates fumbles from edits by latency", () => {
    const attribution = attributeCorrections(
      "the cat sat",
      [
        { seq: 0, tsMs: 300, charIndex: 4, runLength: 1, expectedCode: null },
        { seq: 1, tsMs: 450, charIndex: 5, runLength: 1, expectedCode: null },
        { seq: 2, tsMs: 900, charIndex: 6, runLength: 1, expectedCode: null },
        { seq: 3, tsMs: 5_000, charIndex: 8, runLength: 1, expectedCode: null },
      ],
      KEYSTROKES,
    );
    // Measured from the last keystroke at 200 ms: 100, 250, 700 and 4800 ms.
    expect(attribution.byLatency).toEqual({ fumble: 2, ambiguous: 1, edit: 1 });
  });

  test("reports the character offset within the word", () => {
    const attribution = attributeCorrections(
      "sat cat sat",
      [
        { seq: 0, tsMs: 250, charIndex: 2, runLength: 1, expectedCode: null },
        { seq: 1, tsMs: 260, charIndex: 10, runLength: 1, expectedCode: null },
        { seq: 2, tsMs: 270, charIndex: 6, runLength: 1, expectedCode: null },
      ],
      KEYSTROKES,
    );
    // "sat" occurs twice, and both corrections land on its third letter — the finding the offset
    // histogram exists to make visible.
    const sat = attribution.words.find((word) => word.word === "sat");
    expect(sat).toMatchObject({ occurrences: 2, corrections: 2, correctionRate: 1 });
    expect(sat?.offsets).toEqual([{ offset: 2, count: 2 }]);
  });

  test("a session with no corrections produces empty aggregates, not a crash", () => {
    expect(attributeCorrections("the cat", [], KEYSTROKES)).toEqual({
      corrections: 0,
      charactersRemoved: 0,
      byLatency: { fumble: 0, ambiguous: 0, edit: 0 },
      words: [],
      transitions: [],
      unattributed: 0,
    });
    // No text either: a pre-v2 session has no prompt to attribute against.
    expect(attributeCorrections("", [], [])).toMatchObject({ corrections: 0, words: [] });
  });

  test("a correction past the end of the prompt is reported, not dropped", () => {
    const attribution = attributeCorrections(
      "the",
      [{ seq: 0, tsMs: 250, charIndex: 5, runLength: 2, expectedCode: null }],
      KEYSTROKES,
    );
    expect(attribution.corrections).toBe(1);
    expect(attribution.unattributed).toBe(1);
    expect(attribution.charactersRemoved).toBe(2);
    expect(attribution.words).toEqual([]);
  });
});
