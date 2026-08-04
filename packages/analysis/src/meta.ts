import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Hand = "L" | "R";

export interface PositionMeta {
  pos: number;
  hand: Hand;
  row: number;
  col: number | null;
  finger: string;
  fingerId: number;
  baseKeycode: string | null;
  baseBinding: string;
  isHrm: boolean;
  modClass?: string;
}

interface KeymapMetaFile {
  schemaVersion: number;
  positions: PositionMeta[];
}

export interface AnalysisMeta {
  positions: readonly PositionMeta[];
  positionsByPos: ReadonlyMap<number, PositionMeta>;
  altHandAmbiguous: boolean;
  position(pos: number): PositionMeta | undefined;
  finger(pos: number): string | undefined;
  row(pos: number): number | undefined;
  col(pos: number): number | null | undefined;
}

interface MetaRow {
  value: string;
}

function isHand(value: unknown): value is Hand {
  return value === "L" || value === "R";
}

function parsePosition(value: unknown, index: number): PositionMeta {
  if (!value || typeof value !== "object") {
    throw new Error(`keymap metadata position ${index} is not an object`);
  }
  const position = value as Record<string, unknown>;
  if (
    !Number.isInteger(position.pos)
    || !isHand(position.hand)
    || !Number.isInteger(position.row)
    || !(position.col === null || Number.isInteger(position.col))
    || typeof position.finger !== "string"
    || !Number.isInteger(position.fingerId)
    || !(position.baseKeycode === null || typeof position.baseKeycode === "string")
    || typeof position.baseBinding !== "string"
    || typeof position.isHrm !== "boolean"
    || !(position.modClass === undefined || typeof position.modClass === "string")
  ) {
    throw new Error(`keymap metadata position ${index} is invalid`);
  }
  return position as unknown as PositionMeta;
}

export function loadAnalysisMeta(
  database: Database,
  path = resolve(dirname(fileURLToPath(import.meta.url)), "../../../out/keymap-meta.json"),
): AnalysisMeta {
  let parsed: KeymapMetaFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as KeymapMetaFile;
  } catch (error) {
    throw new Error(`Unable to load keymap metadata from ${path}`, { cause: error });
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.positions) || parsed.positions.length !== 80) {
    throw new Error("Unsupported or invalid keymap metadata; expected schemaVersion 1 with 80 positions");
  }

  const positions = parsed.positions.map(parsePosition).sort((left, right) => left.pos - right.pos);
  const positionsByPos = new Map<number, PositionMeta>();
  for (const position of positions) {
    if (position.pos < 0 || position.pos > 79 || positionsByPos.has(position.pos)) {
      throw new Error(`Invalid or duplicate keymap position ${position.pos}`);
    }
    positionsByPos.set(position.pos, position);
  }
  if (positionsByPos.size !== 80) {
    throw new Error("keymap metadata must cover every position from 0 through 79");
  }

  const altRow = database
    .query("SELECT value FROM meta WHERE key = 'alt_hand_ambiguous'")
    .get() as MetaRow | null;

  return {
    positions,
    positionsByPos,
    altHandAmbiguous: altRow?.value === "1",
    position: (pos) => positionsByPos.get(pos),
    finger: (pos) => positionsByPos.get(pos)?.finger,
    row: (pos) => positionsByPos.get(pos)?.row,
    col: (pos) => positionsByPos.get(pos)?.col,
  };
}
