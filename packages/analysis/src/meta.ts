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

export interface LayerMeta {
  index: number;
  name: string;
}

interface KeymapMetaFile {
  schemaVersion: number;
  positions: PositionMeta[];
  layers?: unknown[];
}

export interface AnalysisMeta {
  positions: readonly PositionMeta[];
  positionsByPos: ReadonlyMap<number, PositionMeta>;
  layers: readonly LayerMeta[];
  layersByIndex: ReadonlyMap<number, LayerMeta>;
  altHandAmbiguous: boolean;
  position(pos: number): PositionMeta | undefined;
  finger(pos: number): string | undefined;
  row(pos: number): number | undefined;
  col(pos: number): number | null | undefined;
  layer(index: number): LayerMeta | undefined;
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

function parseLayer(value: unknown, index: number): LayerMeta {
  if (!value || typeof value !== "object") {
    throw new Error(`keymap metadata layer ${index} is not an object`);
  }
  const layer = value as Record<string, unknown>;
  if (
    !Number.isInteger(layer.index)
    || Number(layer.index) < 0
    || Number(layer.index) > 15
    || typeof layer.name !== "string"
    || layer.name.length === 0
  ) {
    throw new Error(`keymap metadata layer ${index} is invalid`);
  }
  return { index: Number(layer.index), name: layer.name };
}

export function loadAnalysisMeta(
  database: Database | null,
  path = resolve(dirname(fileURLToPath(import.meta.url)), "../../../out/keymap-meta.json"),
): AnalysisMeta {
  let parsed: KeymapMetaFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as KeymapMetaFile;
  } catch (error) {
    throw new Error(`Unable to load keymap metadata from ${path}`, { cause: error });
  }
  // A board smaller than the Glove80 is legitimate — the laptop QWERTY has fewer keys — but the
  // Tier B position space runs 0-79 plus the unattributed slot, so 80 is a hard ceiling.
  if (
    parsed.schemaVersion !== 1
    || !Array.isArray(parsed.positions)
    || parsed.positions.length === 0
    || parsed.positions.length > 80
  ) {
    throw new Error(
      "Unsupported or invalid keymap metadata; expected schemaVersion 1 with 1 to 80 positions",
    );
  }

  const positions = parsed.positions.map(parsePosition).sort((left, right) => left.pos - right.pos);
  const positionsByPos = new Map<number, PositionMeta>();
  for (const position of positions) {
    if (position.pos < 0 || position.pos > 79 || positionsByPos.has(position.pos)) {
      throw new Error(`Invalid or duplicate keymap position ${position.pos}`);
    }
    positionsByPos.set(position.pos, position);
  }

  const layers = (parsed.layers ?? []).map(parseLayer).sort((left, right) => left.index - right.index);
  const layersByIndex = new Map<number, LayerMeta>();
  for (const layer of layers) {
    if (layersByIndex.has(layer.index)) {
      throw new Error(`Duplicate keymap layer index ${layer.index}`);
    }
    layersByIndex.set(layer.index, layer);
  }

  const altRow = database
    ? database.query("SELECT value FROM meta WHERE key = 'alt_hand_ambiguous'")
      .get() as MetaRow | null
    : null;

  return {
    positions,
    positionsByPos,
    layers,
    layersByIndex,
    altHandAmbiguous: altRow?.value === "1",
    position: (pos) => positionsByPos.get(pos),
    finger: (pos) => positionsByPos.get(pos)?.finger,
    row: (pos) => positionsByPos.get(pos)?.row,
    col: (pos) => positionsByPos.get(pos)?.col,
    layer: (index) => layersByIndex.get(index),
  };
}
