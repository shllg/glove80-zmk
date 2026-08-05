import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Own-material corpus builder: commit subjects, code identifiers, and prose from this repository.
 *
 * The point is that generic word lists drill generic text. The text you actually type is your own
 * commit messages and your own identifiers, and those have a different shape — symbols, case
 * changes, and a vocabulary a common-words list will never contain.
 *
 * **This is exactly the material that makes the trainer's keystroke log sensitive.** The store puts
 * it in a 0700 directory with a CACHEDIR.TAG for that reason. Everything here reads from the
 * repository only; it never touches user documents, and it never leaves the machine.
 */

export interface OwnMaterialOptions {
  repositoryPath?: string;
  limit?: number;
}

/** Commit subjects, which are short, real, and already in your fingers. */
export function commitSubjects(options: OwnMaterialOptions = {}): string[] {
  const limit = options.limit ?? 200;
  try {
    const output = execFileSync(
      "git",
      ["log", `--max-count=${limit}`, "--format=%s"],
      {
        cwd: options.repositoryPath ?? process.cwd(),
        encoding: "utf8",
        // A non-repository directory is an expected outcome, not a fault worth printing.
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.length <= 120);
  } catch {
    // A missing git, a shallow clone, or a non-repository directory is not an error worth failing
    // a drill over; the caller falls back to the built-in identifier pool.
    return [];
  }
}

const IDENTIFIER_PATTERN = /\b[a-z][A-Za-z0-9]*(?:[_A-Z][A-Za-z0-9]*)+\b/g;

/** Multi-word identifiers only: `x` and `for` teach nothing, `seal_or_discard_tier_a` does. */
export function codeIdentifiers(files: readonly string[], limit = 200): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IDENTIFIER_PATTERN)) {
      const identifier = match[0];
      if (identifier.length < 6 || identifier.length > 40) continue;
      counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([identifier]) => identifier);
}

/** Splits commit subjects into a word pool a position drill can weight. */
export function proseWords(lines: readonly string[], limit = 400): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    for (const word of line.toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
      if (word.length < 3 || word.length > 24) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([word]) => word);
}
