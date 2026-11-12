/**
 * Bounds of the flourish shapes in flourishes.ts, in em of the composer line (pure data, so the
 * layout can use them without Path2D). Each shape is the LEFT ornament: its inner end (next to the
 * name) is at x ≈ 0 and it extends to negative x; the right one is mirrored.
 * Measured from the drawn ink (tests/e2e/title-card.mjs checks they still match the paths).
 */
export const FLOURISH_BOUNDS = {
  vine: { minX: -3.42, maxX: 0.15, minY: -1.05, maxY: 0.48 },
  scroll: { minX: -3.74, maxX: 0.02, minY: -0.58, maxY: 0.58 },
} as const;

export type FlourishId = keyof typeof FLOURISH_BOUNDS;
