import type { AnalysisMeta } from "@glove80/analysis/meta";
import type { AnalysisMetrics } from "@glove80/analysis/metrics";
import { generateBenchmark } from "./corpus";
import {
  generateBigramDrill,
  generateLanguageDrill,
  generateMechanicDrill,
  generatePositionDrill,
  type DrillFamily,
  type MechanicDrill,
  type MechanicDrillStep,
} from "./drills";
import type { TrainerStore } from "./store";
import { buildWeaknessModel, type WeaknessModel } from "./weakness";

export interface TrainingRequest {
  mode?: unknown;
  corpusId?: unknown;
  family?: unknown;
  language?: unknown;
  seed?: unknown;
  wordCount?: unknown;
  deviceLabel?: unknown;
}

export interface PreparedTrainingSession {
  mode: "benchmark" | "drill";
  text: string;
  corpusId: string;
  corpusVersion: string;
  seed: number;
  language: string;
  deviceLabel: string;
  drillFamily: DrillFamily | null;
  rationale: string | null;
  confidence: WeaknessModel["confidence"] | null;
  steps: MechanicDrillStep[] | null;
}

function positiveWordCount(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 500) {
    throw new Error("wordCount must be an integer from 1 through 500");
  }
  return Number(value);
}

function seedFrom(value: unknown): number {
  if (value === undefined) return Math.floor(Math.random() * 0x1_0000_0000);
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 0xffff_ffff) {
    throw new Error("seed must be an integer from 0 through 4294967295");
  }
  return Number(value);
}

function languageFrom(value: unknown): "en" | "de" | "code" {
  if (value === undefined) return "en";
  if (value === "en" || value === "de" || value === "code") return value;
  throw new Error("language must be en, de, or code");
}

function familyFrom(value: unknown): DrillFamily {
  if (value === undefined) return "position";
  if (value === "position" || value === "bigram" || value === "mechanic" || value === "language") {
    return value;
  }
  throw new Error("family must be position, bigram, mechanic, or language");
}

/**
 * Generates a prompt and its provenance without creating a database row. Lab owns the ephemeral
 * active session; only its finish endpoint turns this value into a completed, atomic record.
 */
export function prepareTrainingSession(
  store: TrainerStore,
  meta: AnalysisMeta | undefined,
  metrics: AnalysisMetrics | undefined,
  request: TrainingRequest,
): PreparedTrainingSession {
  const seed = seedFrom(request.seed);
  const language = languageFrom(request.language);
  const deviceLabel = typeof request.deviceLabel === "string" && request.deviceLabel.length > 0
    ? request.deviceLabel.slice(0, 200)
    : "unknown";

  if (request.mode !== undefined && request.mode !== "benchmark" && request.mode !== "drill") {
    throw new Error("mode must be benchmark or drill");
  }
  const mode = request.mode === "drill" ? "drill" : "benchmark";
  if (mode === "benchmark") {
    if (language === "code") throw new Error("code has drills but no fixed benchmark corpus");
    const corpusId = typeof request.corpusId === "string"
      ? request.corpusId
      : language === "de" ? "de-common" : "en-common";
    const generated = generateBenchmark(corpusId, seed, positiveWordCount(request.wordCount, 50));
    return {
      mode,
      text: generated.text,
      corpusId: generated.corpusId,
      corpusVersion: generated.corpusVersion,
      seed,
      language: generated.language,
      deviceLabel,
      drillFamily: null,
      rationale: null,
      confidence: null,
      steps: null,
    };
  }

  const family = familyFrom(request.family);
  if (meta === undefined) {
    throw new Error("Drills require generated keymap metadata");
  }
  if (family === "mechanic" && metrics === undefined) {
    throw new Error("Mechanic drills require current keylab telemetry");
  }
  const weakness = buildWeaknessModel(store.database, meta, metrics);
  const wordCount = positiveWordCount(request.wordCount, family === "language" ? 30 : 40);
  const drill = family === "bigram"
    ? generateBigramDrill(weakness, meta, seed, { repetitions: Math.max(1, Math.ceil(wordCount / 3)) })
    : family === "mechanic"
      ? generateMechanicDrill(weakness, seed)
      : family === "language"
        ? generateLanguageDrill(seed, { language, wordCount })
        : generatePositionDrill(weakness, seed, { language, wordCount });
  return {
    mode,
    text: drill.text,
    corpusId: drill.corpusId,
    corpusVersion: drill.corpusVersion,
    seed,
    language: drill.language,
    deviceLabel,
    drillFamily: family,
    rationale: drill.rationale,
    confidence: weakness.confidence,
    steps: family === "mechanic" ? (drill as MechanicDrill).steps : null,
  };
}
