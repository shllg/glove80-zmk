export interface StructuredLayout {
  left: string[][];
  right: string[][];
  thumb_left: string[][];
  thumb_right: string[][];
}

/**
 * Convert structured keyboard layout to physical rows matching ZMK key order.
 * Returns 6 rows: F-keys(10), Numbers(12), QWERTY(12), Home(12), Bottom+Thumb-upper(18), Corner+Thumb-lower(16)
 */
export function toPhysicalRows(layout: StructuredLayout): string[][] {
  return [
    [...layout.left[0], ...layout.right[0]],
    [...layout.left[1], ...layout.right[1]],
    [...layout.left[2], ...layout.right[2]],
    [...layout.left[3], ...layout.right[3]],
    [...layout.left[4], ...layout.thumb_left[0], ...layout.thumb_right[0], ...layout.right[4]],
    [...layout.left[5], ...layout.thumb_left[1], ...layout.thumb_right[1], ...layout.right[5]],
  ];
}

/**
 * Flatten structured layout to 80-key array in ZMK position order.
 */
export function flattenToPositions(layout: StructuredLayout): string[] {
  return toPhysicalRows(layout).flat();
}
