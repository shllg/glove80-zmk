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
import { benchmarkHistory, runTrainer } from "../src/server";
import { defaultTrainerPath, openTrainerStore } from "../src/store";
import { buildWeaknessModel } from "../src/weakness";

const USAGE = "Usage: trainer serve [--port N]\n"
  + "       trainer weakness [--db PATH] [--trainer PATH]\n"
  + "       trainer benchmark [--corpus ID] [--seed N] [--words N]\n"
  + "       trainer drill [--family position|bigram|mechanic|language] [--language en|de|code]\n"
  + "       trainer history [--trainer PATH]\n"
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

  if (command === "serve") {
    runTrainer(rest);
    return;
  }

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
        const measured = position.errorRate === null
          ? `${position.presses} presses (frequency only)`
          : `${(position.errorRate * 100).toFixed(1)}% errors over ${position.attempts}`;
        process.stdout.write(
          `  ${position.label.padEnd(6)} ${position.finger.padEnd(10)} ${measured}\n`,
        );
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
