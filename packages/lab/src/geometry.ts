import { toPhysicalRows, type StructuredLayout } from "../../keymap/src/layout";

export type GeometrySection = "left-main" | "left-thumb" | "right-thumb" | "right-main";

export interface GeometryCell {
  pos: number;
  physicalRow: number;
  indexInRow: number;
  section: GeometrySection;
  x: number;
  y: number;
  rotation: number;
}

const THUMB_GEOMETRY = new Map<number, { x: number; y: number; rotation: number }>([
  [52, { x: 371, y: 312, rotation: 30 }],
  [53, { x: 420, y: 350, rotation: 45 }],
  [54, { x: 458, y: 399, rotation: 60 }],
  [55, { x: 550, y: 399, rotation: -60 }],
  [56, { x: 588, y: 350, rotation: -45 }],
  [57, { x: 637, y: 312, rotation: -30 }],
  [69, { x: 314, y: 347, rotation: 20 }],
  [70, { x: 369, y: 379, rotation: 40 }],
  [71, { x: 410, y: 427, rotation: 60 }],
  [72, { x: 598, y: 427, rotation: -60 }],
  [73, { x: 639, y: 379, rotation: -40 }],
  [74, { x: 694, y: 347, rotation: -20 }],
]);

function sequence(start: number, length: number): string[] {
  return Array.from({ length }, (_, offset) => String(start + offset));
}

export function positionStructuredLayout(): StructuredLayout {
  return {
    left: [
      sequence(0, 5),
      sequence(10, 6),
      sequence(22, 6),
      sequence(34, 6),
      sequence(46, 6),
      sequence(64, 5),
    ],
    right: [
      sequence(5, 5),
      sequence(16, 6),
      sequence(28, 6),
      sequence(40, 6),
      sequence(58, 6),
      sequence(75, 5),
    ],
    thumb_left: [sequence(52, 3), sequence(69, 3)],
    thumb_right: [sequence(55, 3), sequence(72, 3)],
  };
}

function sectionFor(physicalRow: number, indexInRow: number): GeometrySection {
  if (physicalRow <= 3) {
    const halfLength = physicalRow === 0 ? 5 : 6;
    return indexInRow < halfLength ? "left-main" : "right-main";
  }
  if (physicalRow === 4) {
    if (indexInRow < 6) return "left-main";
    if (indexInRow < 9) return "left-thumb";
    if (indexInRow < 12) return "right-thumb";
    return "right-main";
  }
  if (indexInRow < 5) return "left-main";
  if (indexInRow < 8) return "left-thumb";
  if (indexInRow < 11) return "right-thumb";
  return "right-main";
}

export function buildHeatmapGeometry(): GeometryCell[] {
  return toPhysicalRows(positionStructuredLayout()).flatMap((row, physicalRow) =>
    row.map((rawPosition, indexInRow) => {
      const pos = Number(rawPosition);
      const section = sectionFor(physicalRow, indexInRow);
      const thumb = THUMB_GEOMETRY.get(pos);
      if (thumb) return { pos, physicalRow, indexInRow, section, ...thumb };

      const left = section === "left-main";
      const localIndex = left
        ? indexInRow
        : indexInRow - (physicalRow === 0 ? 5 : physicalRow <= 3 ? 6 : physicalRow === 4 ? 12 : 11);
      const firstX = left ? 28 : (physicalRow === 0 || physicalRow === 5 ? 756 : 700);
      const x = firstX + localIndex * 56;
      const outerColumnOffset = x === 28 || x === 84 || x === 924 || x === 980 ? 28 : 0;
      return {
        pos,
        physicalRow,
        indexInRow,
        section,
        x,
        y: 28 + physicalRow * 56 + outerColumnOffset,
        rotation: 0,
      };
    }),
  );
}

export function orderByGlove80Geometry<T extends { pos: number }>(positions: readonly T[]): T[] {
  const byPosition = new Map(positions.map((position) => [position.pos, position]));
  return buildHeatmapGeometry().map(({ pos }) => {
    const position = byPosition.get(pos);
    if (!position) throw new Error(`Missing heatmap position ${pos}`);
    return position;
  });
}

/**
 * A board that is not the Glove80 has no hand-placed geometry here, so it is rendered in its own
 * metadata order: row first, then column outward-to-inward, which is how a row-staggered board
 * reads. Falling back to Glove80 coordinates would draw a keyboard that does not exist.
 */
export function orderByRowMajorGeometry<
  T extends { pos: number; hand: string; row: number; col: number | null },
>(positions: readonly T[]): T[] {
  return [...positions].sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row;
    if (left.hand !== right.hand) return left.hand === "L" ? -1 : 1;
    const leftCol = left.col ?? 0;
    const rightCol = right.col ?? 0;
    // Left hand runs outward-to-inward, the right hand mirrors it.
    const byColumn = left.hand === "L" ? rightCol - leftCol : leftCol - rightCol;
    return byColumn !== 0 ? byColumn : left.pos - right.pos;
  });
}

/** Chooses the ordering that belongs to a device's position space. */
export function orderForPositionSpace<
  T extends { pos: number; hand: string; row: number; col: number | null },
>(positionSpace: string | null, positions: readonly T[]): T[] {
  return positionSpace === null || positionSpace === "glove80"
    ? orderByGlove80Geometry(positions)
    : orderByRowMajorGeometry(positions);
}
