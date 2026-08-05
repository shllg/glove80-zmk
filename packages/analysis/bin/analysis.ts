#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openKeylabDatabase } from "../src/db";
import { loadAnalysisMeta } from "../src/meta";
import { calculateMetrics, parseSince } from "../src/metrics";
import { renderReport } from "../src/report";

interface CliOptions {
  since: string;
  dbPath: string;
  json: boolean;
  profile: string;
}

export function parseAnalysisArgs(args: string[]): CliOptions {
  if (args[0] !== "report") {
    throw new Error(
      "Usage: analysis report [--since 7d|24h|30m|all] [--db PATH] [--profile NAME|*] [--json]",
    );
  }
  const options: CliOptions = {
    since: "7d",
    dbPath: join(homedir(), ".local/share/glove80-lab/keylab.db"),
    json: false,
    profile: "default",
  };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--since") {
      const value = args[index + 1];
      if (!value) throw new Error("--since requires a value");
      options.since = value;
      index += 1;
    } else if (argument === "--profile") {
      const value = args[index + 1];
      if (!value) throw new Error("--profile requires a name or *");
      options.profile = value;
      index += 1;
    } else if (argument === "--db") {
      const value = args[index + 1];
      if (!value) throw new Error("--db requires a path");
      options.dbPath = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  parseSince(options.since);
  return options;
}

export function runAnalysis(args: string[]): void {
  const options = parseAnalysisArgs(args);
  const database = openKeylabDatabase(options.dbPath);
  try {
    const meta = loadAnalysisMeta(database);
    const metrics = calculateMetrics(database, meta, parseSince(options.since), {
      profile: options.profile,
    });
    process.stdout.write(options.json ? `${JSON.stringify(metrics, null, 2)}\n` : renderReport(metrics));
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    runAnalysis(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`analysis: ${message}`);
    process.exitCode = 1;
  }
}
