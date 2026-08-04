export interface StructuredLayout {
  left: string[][];
  right: string[][];
  thumb_left: string[][];
  thumb_right: string[][];
}

function rowAt(rows: string[][], index: number, section: string): string[] {
  const row = rows[index];
  if (!row) {
    throw new Error(`Missing ${section} row ${index + 1}`);
  }
  return row;
}

/**
 * Convert structured keyboard layout to physical rows matching ZMK key order.
 * Returns 6 rows: F-keys(10), Numbers(12), QWERTY(12), Home(12), Bottom+Thumb-upper(18), Corner+Thumb-lower(16)
 */
export function toPhysicalRows(layout: StructuredLayout): string[][] {
  return [
    [...rowAt(layout.left, 0, "left"), ...rowAt(layout.right, 0, "right")],
    [...rowAt(layout.left, 1, "left"), ...rowAt(layout.right, 1, "right")],
    [...rowAt(layout.left, 2, "left"), ...rowAt(layout.right, 2, "right")],
    [...rowAt(layout.left, 3, "left"), ...rowAt(layout.right, 3, "right")],
    [
      ...rowAt(layout.left, 4, "left"),
      ...rowAt(layout.thumb_left, 0, "left thumb"),
      ...rowAt(layout.thumb_right, 0, "right thumb"),
      ...rowAt(layout.right, 4, "right"),
    ],
    [
      ...rowAt(layout.left, 5, "left"),
      ...rowAt(layout.thumb_left, 1, "left thumb"),
      ...rowAt(layout.thumb_right, 1, "right thumb"),
      ...rowAt(layout.right, 5, "right"),
    ],
  ];
}

/**
 * Flatten structured layout to 80-key array in ZMK position order.
 */
export function flattenToPositions(layout: StructuredLayout): string[] {
  return toPhysicalRows(layout).flat();
}
