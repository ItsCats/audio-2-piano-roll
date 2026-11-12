/**
 * Bounds of the flourish shapes in flourishes.ts, in em of the composer line (pure data, so the
 * layout can use them without Path2D). Each shape is the LEFT ornament: its inner end (next to the
 * name) is at x ≈ 0 and it extends to negative x; the right one is mirrored.
 */
export const FLOURISH_BOUNDS = {
  vine: { minX: -3.7, maxX: 0.15, minY: -0.75, maxY: 0.55 },
  scroll: { minX: -3.5, maxX: 0.05, minY: -0.6, maxY: 0.6 },
} as const;

export type FlourishId = keyof typeof FLOURISH_BOUNDS;
