#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { openKeylabDatabase } from "@glove80/analysis/db";
import { loadAnalysisMeta } from "@glove80/analysis/meta";
import { calculateMetrics, parseSince } from "@glove80/analysis/metrics";
import { generateBenchmark, listCorpora } from "../src/corpus";
import {
  generateBigramDrill,
  generateLanguageDrill,
  generateMechanicDrill,
  generatePositionDrill,
} from "../src/drills";
import { attributeCorrections } from "../src/corrections";
import { benchmarkHistory } from "../src/history";
import { defaultTrainerPath, openTrainerStore } from "../src/store";
import { buildWeaknessModel } from "../src/weakness";

const USAGE = "Usage: trainer weakness [--db PATH] [--trainer PATH]\n"
  + "       trainer benchmark [--corpus ID] [--seed N] [--words N]\n"
  + "       trainer drill [--family position|bigram|mechanic|language] [--language en|de|code]\n"
  + "       trainer history [--trainer PATH]\n"
  + "       trainer corrections [--trainer PATH] [--session N]\n"
  + "       trainer corpora";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function keylabContext(args: string[]) {
  const path = flag(args, "--db") ?? join(homedir(), ".local/share/glove80-lab/keylab.db");
  const database = openKeylabDatabase(path);
  try {
    const meta = loadAnalysisMeta(database);
    const metrics = calculateMetrics(
      database,
      meta,
      parseSince("all"),
      { profile: "*" },
    );
    return { meta, metrics };
  } finally {
    database.close();
  }
}

export function runCli(args: string[]): void {
  const command = args[0];
  const rest = args.slice(1);

  if (command === "corpora") {
    for (const entry of listCorpora()) {
      process.stdout.write(
        `${entry.id.padEnd(12)} ${entry.family.padEnd(10)} ${entry.language}  @${entry.version}`
        + `  ${entry.words.length} words\n`,
      );
    }
    return;
  }

  if (command === "benchmark") {
    const seed = Number(flag(rest, "--seed") ?? Math.floor(Math.random() * 0xffffffff));
    const words = Number(flag(rest, "--words") ?? 50);
    const generated = generateBenchmark(flag(rest, "--corpus") ?? "en-common", seed, words);
    process.stdout.write(
      `# ${generated.corpusId} @ ${generated.corpusVersion}  seed ${generated.seed}`
      + `  ${generated.wordCount} words\n${generated.text}\n`,
    );
    return;
  }

  const trainerPath = flag(rest, "--trainer") ?? defaultTrainerPath();

  if (command === "weakness") {
    const { meta, metrics } = keylabContext(rest);
    const store = openTrainerStore(trainerPath);
    try {
      const model = buildWeaknessModel(store.database, meta, metrics);
      process.stdout.write(`confidence: ${model.confidence} (${model.sessionCount} sessions)\n`);
      process.stdout.write("\nMechanics (keylab Tier A — no word list can surface these)\n");
      for (const mechanic of model.mechanics) {
        process.stdout.write(`  ${mechanic.label.padEnd(22)} ${mechanic.detail}\n`);
      }
      process.stdout.write("\nPositions\n");
      for (const position of model.positions) {
        const measured = position.errorRate !== null
          ? `${(position.errorRate * 100).toFixed(1)}% errors over ${position.attempts}`
          : position.correctionRate !== null
            ? `${position.presses} presses (corrections, no trainer history)`
            : `${position.presses} presses (frequency only)`;
        // A correction count without its press count is a frequency ranking wearing a disguise.
        const corrected = position.correctionRate !== null
          ? `  ${position.corrections} corrections, `
            + `${(position.correctionRate * 100).toFixed(2)}% fumble-weighted per press`
          : position.corrections > 0
            ? `  ${position.corrections} corrections (too few presses to rate)`
            : "";
        process.stdout.write(
          `  ${position.label.padEnd(6)} ${position.finger.padEnd(10)} ${measured}${corrected}\n`,
        );
      }
      if (model.correctedTransitions.length > 0) {
        process.stdout.write("\nCorrected transitions (keylab Tier C)\n");
        for (const transition of model.correctedTransitions) {
          process.stdout.write(
            `  ${transition.label.padEnd(24)} ${String(transition.corrections).padStart(5)}`
            + " corrections"
            + (transition.degraded ? "  (finger-level, no position identity)" : "")
            + (transition.sameFinger ? "  same finger" : "")
            + "\n",
          );
        }
      }
      if (model.bigrams.length > 0) {
        process.stdout.write("\nSlowest transitions\n");
        for (const bigram of model.bigrams) {
          process.stdout.write(
            `  ${bigram.label.padEnd(24)} ${bigram.medianLatencyMs.toFixed(0)} ms`
            + ` (n=${bigram.occurrences}${bigram.sameFinger ? ", same finger" : ""})\n`,
          );
        }
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "drill") {
    const family = flag(rest, "--family") ?? "position";
    const language = flag(rest, "--language") ?? "en";
    const seed = Number(flag(rest, "--seed") ?? Math.floor(Math.random() * 0xffffffff));
    const { meta, metrics } = keylabContext(rest);
    const store = openTrainerStore(trainerPath);
    try {
      const weakness = buildWeaknessModel(store.database, meta, metrics);
      const drill = family === "bigram"
        ? generateBigramDrill(weakness, meta, seed)
        : family === "mechanic"
          ? generateMechanicDrill(weakness, seed)
          : family === "language"
            ? generateLanguageDrill(seed, { language })
            : generatePositionDrill(weakness, seed, { language });
      process.stdout.write(`# ${drill.family} · seed ${drill.seed}\n# ${drill.rationale}\n`);
      const steps = (drill as { steps?: Array<{ instruction: string }> }).steps;
      if (steps) {
        for (const [index, step] of steps.entries()) {
          process.stdout.write(`${index + 1}. ${step.instruction}\n`);
        }
      } else {
        process.stdout.write(`${drill.text}\n`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "history") {
    const store = openTrainerStore(trainerPath);
    try {
      const history = benchmarkHistory(store);
      if (history.points.length === 0) {
        process.stdout.write("no completed benchmark runs yet\n");
        return;
      }
      for (const [language, medians] of Object.entries(history.rollingMedianWpm)) {
        const runs = history.points.filter((point) => point.language === language);
        process.stdout.write(
          `${language}: ${runs.length} runs, rolling median `
          + `${(medians[medians.length - 1] ?? 0).toFixed(1)} WPM\n`,
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "corrections") {
    const only = flag(rest, "--session");
    // A digraph containing a space is unreadable raw; the analysis report uses the same glyph.
    const visible = (text: string) => text.replaceAll(" ", "␣");
    const store = openTrainerStore(trainerPath);
    try {
      let printed = 0;
      let unattributable = 0;
      for (const session of store.sessions()) {
        if (session.endedTs === null) continue;
        if (only !== undefined && session.id !== Number(only)) continue;
        const corrections = store.corrections(session.id);
        if (corrections.length === 0) continue;
        if (session.text === null) {
          // Pre-v2 sessions never stored their prompt, so there is no ground truth to attribute
          // against. Counting them silently as zero would read as clean practice.
          unattributable += 1;
          continue;
        }
        const attribution = attributeCorrections(
          session.text,
          corrections,
          store.keystrokes(session.id),
        );
        const { fumble, ambiguous, edit } = attribution.byLatency;
        printed += 1;
        process.stdout.write(
          `\nsession ${session.id}  ${session.mode}  ${session.language}  ${session.corpusId}\n`
          + `  ${attribution.corrections} corrections, `
          + `${attribution.charactersRemoved} characters removed`
          + `  (fumble ${fumble}, ambiguous ${ambiguous}, edit ${edit})\n`,
        );
        if (attribution.unattributed > 0) {
          process.stdout.write(
            `  ${attribution.unattributed} past the end of the prompt, not attributed to a word\n`,
          );
        }
        for (const word of attribution.words.slice(0, 10)) {
          const offsets = word.offsets
            .map((entry) => `${entry.offset}×${entry.count}`)
            .join(" ");
          process.stdout.write(
            `    ${word.word.padEnd(20)} ${String(word.corrections).padStart(4)} in `
            + `${String(word.occurrences).padStart(3)}  offsets ${offsets}\n`,
          );
        }
        if (attribution.transitions.length > 0) {
          process.stdout.write(
            `    transitions  ${attribution.transitions.slice(0, 10)
              .map((entry) => `${visible(entry.transition)} ${entry.corrections}`)
              .join("  ")}\n`,
          );
        }
      }
      if (printed === 0) process.stdout.write("no corrections recorded yet\n");
      if (unattributable > 0) {
        process.stdout.write(
          `\n${unattributable} session(s) recorded corrections before schema v2 stored the prompt `
          + "text; they cannot be attributed to words.\n",
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  throw new Error(USAGE);
}

if (import.meta.main) {
  try {
    runCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(`trainer: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
