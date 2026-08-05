/**
 * Corpora, split into two families that must never mix.
 *
 * **Benchmark pools are frozen and versioned.** They are never fed by the weakness model. The
 * moment weakness data reaches the benchmark corpus the trend line stops meaning anything: you
 * would be measuring improvement against a target that moves toward your weaknesses.
 *
 * **Drill pools are separate.** Drills are generated *from* the weakness model, so they may — and
 * must — drift. Generating a drill from a benchmark pool would contaminate the benchmark by
 * practising exactly the text it measures.
 *
 * Against memorisation the defence is not secrecy: it is a fixed pool with a version tag, a random
 * seed per run, a fixed word count (the same denominator keeps per-position error rates
 * comparable), and a rolling median over the last k runs.
 */

export const BENCHMARK_CORPUS_VERSION = "2026-08-05.1";
export const DRILL_CORPUS_VERSION = "2026-08-05.1";

export interface Corpus {
  id: string;
  version: string;
  language: string;
  family: "benchmark" | "drill";
  words: readonly string[];
}

const ENGLISH_BENCHMARK_WORDS = [
  "about", "after", "again", "along", "another", "because", "before", "being", "between", "both",
  "bring", "build", "carry", "change", "check", "close", "common", "could", "course", "cover",
  "design", "detail", "differ", "during", "early", "enough", "every", "field", "figure", "first",
  "follow", "force", "found", "front", "given", "great", "ground", "group", "happen", "important",
  "include", "inside", "interest", "keep", "kind", "known", "large", "later", "learn", "leave",
  "letter", "level", "light", "little", "local", "material", "matter", "measure", "might", "moment",
  "money", "month", "morning", "mother", "mountain", "music", "natural", "never", "night", "north",
  "notice", "number", "object", "often", "order", "other", "paper", "party", "people", "perhaps",
  "picture", "place", "plant", "point", "power", "press", "price", "problem", "produce", "provide",
  "public", "quick", "quiet", "reach", "ready", "reason", "record", "remember", "result", "return",
  "right", "river", "round", "school", "science", "second", "seem", "sentence", "serve", "several",
  "short", "should", "simple", "since", "small", "sound", "south", "space", "speak", "special",
  "stand", "start", "still", "story", "street", "strong", "study", "subject", "sudden", "summer",
  "system", "table", "teach", "there", "these", "thing", "think", "third", "those", "though",
  "thought", "three", "through", "today", "together", "toward", "travel", "under", "until", "usual",
  "value", "voice", "watch", "water", "where", "whether", "which", "while", "white", "whole",
  "window", "winter", "without", "wonder", "world", "would", "write", "young",
] as const;

/**
 * The German benchmark must contain umlauts or it is not measuring German. On this keymap an `ä`
 * costs **eight** keystrokes (Ctrl+Shift+U, four hex digits, Space — `config/macros.dtsi:87`), so
 * this pool will show a brutal WPM against English. That is the finding, not a bug: the two trend
 * lines are only ever compared against their own history.
 */
const GERMAN_BENCHMARK_WORDS = [
  "aber", "alle", "andere", "arbeit", "auch", "aufgabe", "augen", "ausser", "bald", "bereits",
  "bäume", "beispiel", "berück", "besser", "bezüglich", "bringen", "dabei", "damit", "danach",
  "dennoch", "deutsch", "durch", "dürfen", "eigentlich", "einfach", "einige", "endlich", "erklären",
  "erste", "fahren", "fällen", "familie", "finden", "folgen", "frage", "früher", "führen", "ganze",
  "gebäude", "gedanke", "gehen", "gemäss", "genug", "gerade", "geschichte", "gesellschaft",
  "gespräch", "gestern", "glauben", "gleich", "grösse", "gründe", "haben", "halten", "handeln",
  "häufig", "heute", "hinter", "hören", "immer", "jahre", "jeder", "kaufen", "kennen", "kinder",
  "klein", "kommen", "können", "körper", "lassen", "laufen", "leben", "lernen", "lesen", "letzte",
  "leute", "liegen", "machen", "mädchen", "möchte", "mögen", "möglich", "müssen", "nachher",
  "nächste", "natürlich", "nehmen", "neue", "nicht", "öffnen", "ohne", "plötzlich", "prüfen",
  "rechnen", "reden", "regel", "richtig", "rufen", "sagen", "schön", "schule", "schwer", "sehen",
  "sein", "seite", "selbst", "setzen", "sicher", "sollen", "sprache", "später", "stadt", "stehen",
  "stellen", "stunde", "suchen", "tragen", "träume", "treffen", "über", "überall", "übrigens",
  "unter", "verstehen", "viele", "völlig", "vorher", "während", "warten", "weiter", "welche",
  "wenig", "werden", "wichtig", "wissen", "wohnen", "wollen", "wörter", "zahlen", "zeigen", "zeit",
  "ziemlich", "zurück", "zusammen", "zwischen",
] as const;

/** Drill pools are deliberately a different vocabulary from the benchmark pools. */
const ENGLISH_DRILL_WORDS = [
  "adjacent", "amber", "anchor", "banjo", "beacon", "bishop", "borrow", "bracket", "canvas",
  "cipher", "clover", "cobalt", "column", "crimson", "cypher", "damper", "dazzle", "dolphin",
  "ember", "fabric", "falcon", "fathom", "fjord", "flimsy", "gadget", "gizmo", "glazier", "granite",
  "harbor", "hazard", "hollow", "indigo", "ivory", "jargon", "jigsaw", "junction", "kayak",
  "kernel", "kindle", "lantern", "lattice", "lumber", "magenta", "marble", "meadow", "nimble",
  "nozzle", "obsidian", "onyx", "orchid", "panther", "pixel", "plywood", "quartz", "quiver",
  "ratchet", "rhubarb", "ripple", "saffron", "sapphire", "scaffold", "sequoia", "shrimp", "sphinx",
  "spindle", "sprocket", "syntax", "tangent", "thicket", "timber", "topaz", "trellis", "turquoise",
  "umber", "vellum", "velvet", "vertex", "walnut", "whisker", "willow", "xenon", "yonder", "zephyr",
  "zigzag", "zinc",
] as const;

const GERMAN_DRILL_WORDS = [
  "abzug", "ähnlich", "ausdruck", "bäcker", "bündel", "dämmerung", "dünger", "eichhörnchen",
  "fächer", "flöte", "föhn", "gärtner", "größte", "häuser", "hörsaal", "jäger", "käfer", "köcher",
  "künstler", "lächeln", "löffel", "mühle", "münze", "nächte", "nördlich", "öfter", "ölfarbe",
  "pförtner", "prüfung", "quälen", "rätsel", "röhre", "rückfahrt", "säule", "schlüssel", "spülung",
  "stärke", "störung", "süden", "tägliche", "türme", "übung", "vögel", "wärme", "würfel", "zähler",
  "zögern", "zünder",
] as const;

const CORPORA: readonly Corpus[] = [
  {
    id: "en-common",
    version: BENCHMARK_CORPUS_VERSION,
    language: "en",
    family: "benchmark",
    words: ENGLISH_BENCHMARK_WORDS,
  },
  {
    id: "de-common",
    version: BENCHMARK_CORPUS_VERSION,
    language: "de",
    family: "benchmark",
    words: GERMAN_BENCHMARK_WORDS,
  },
  {
    id: "en-drill",
    version: DRILL_CORPUS_VERSION,
    language: "en",
    family: "drill",
    words: ENGLISH_DRILL_WORDS,
  },
  {
    id: "de-drill",
    version: DRILL_CORPUS_VERSION,
    language: "de",
    family: "drill",
    words: GERMAN_DRILL_WORDS,
  },
];

export function listCorpora(): readonly Corpus[] {
  return CORPORA;
}

export function corpus(id: string): Corpus {
  const found = CORPORA.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Unknown corpus ${JSON.stringify(id)}; known: ${CORPORA.map((c) => c.id).join(", ")}`);
  }
  return found;
}

/**
 * mulberry32. A named, seeded generator rather than `Math.random` so a run is reproducible from
 * `session.seed` alone — that is what makes "same seed, same text" auditable after the fact.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleWords(
  words: readonly string[],
  count: number,
  seed: number,
): string[] {
  if (words.length === 0) throw new Error("Cannot sample from an empty word pool");
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => words[Math.floor(random() * words.length)] as string);
}

export interface BenchmarkText {
  corpusId: string;
  corpusVersion: string;
  language: string;
  seed: number;
  wordCount: number;
  text: string;
}

/**
 * A benchmark run: fixed pool, fixed word count, random seed. The word count is fixed rather than
 * the duration so every run shares a denominator and per-position error rates stay comparable.
 */
export function generateBenchmark(
  corpusId: string,
  seed: number,
  wordCount = 50,
): BenchmarkText {
  const pool = corpus(corpusId);
  if (pool.family !== "benchmark") {
    throw new Error(`Corpus ${corpusId} is a drill pool and must never be used as a benchmark`);
  }
  if (!Number.isInteger(wordCount) || wordCount < 1) {
    throw new Error("Benchmark word count must be a positive integer");
  }
  return {
    corpusId: pool.id,
    corpusVersion: pool.version,
    language: pool.language,
    seed,
    wordCount,
    text: sampleWords(pool.words, wordCount, seed).join(" "),
  };
}
