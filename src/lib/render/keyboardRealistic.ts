/**
 * Photo-like piano keyboard.
 *
 * CONTRACT (used by renderer.ts — keep this signature). Draws the whole keyboard region
 * (from `top` to `top + height`), including the felt strip at the top edge. `keyColor`
 * returns the highlight colour for a pressed key, or null when the key is up.
 */
import type { KeyboardLayout } from './layout';
import type { Ctx2D, RGB } from './color';

export interface RealisticKeyboardOptions {
  top: number;
  height: number;
  width: number;
  scale: number;
  white: RGB;
  black: RGB;
  border: string;
  /** draw "C4"-style labels on C keys */
  showOctaveLabels: boolean;
  /** 0..1 glow strength for pressed keys */
  glow: number;
  hitLine: boolean;
}

export function drawRealisticKeyboard(
  ctx: Ctx2D,
  layout: KeyboardLayout,
  keyColor: (midi: number) => RGB | null,
  o: RealisticKeyboardOptions,
): void {
  void ctx;
  void layout;
  void keyColor;
  void o;
}
