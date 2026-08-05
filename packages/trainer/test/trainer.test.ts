import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeylabDatabase } from "../../analysis/src/db";
import { loadAnalysisMeta } from "../../analysis/src/meta";
import { calculateMetrics, parseSince } from "../../analysis/src/metrics";
import { createFixture, FIXTURE_NOW, type SeededFixture } from "../../analysis/test/fixture";
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
import { codeIdentifiers, commitSubjects, proseWords } from "../src/ownMaterial";
import { COMPOSED_CODE, rollingMedian, scoreSession } from "../src/scoring";
import { benchmarkHistory, createTrainerServer, type TrainerApp } from "../src/server";
import { openTrainerStore, type TrainerStore } from "../src/store";
import { browserCodeToKeyName, buildWeaknessModel } from "../src/weakness";

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

  test("unknown routes and methods are refused", async () => {
    const { app } = startTrainer();
    expect((await fetch(`${app.url}/nope`)).status).toBe(404);
    expect((await fetch(`${app.url}/api/history`, { method: "DELETE" })).status).toBe(405);
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
