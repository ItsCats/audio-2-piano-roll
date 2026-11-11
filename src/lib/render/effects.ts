/**
 * Hit & ambience effects drawn by the renderer.
 *
 * CONTRACT (used by renderer.ts — keep these signatures). Every effect is a PURE FUNCTION OF
 * TIME: given the same notes and `now`, it draws the same pixels (no Math.random, no state
 * carried between frames) so seeking works and exported video frames are deterministic.
 * Use `hash()` from ./color for pseudo-randomness seeded by note id / particle index.
 */
import type { EffectSettings } from './settings';
import type { Ctx2D, RGB } from './color';

/** A note relevant to effects: currently sounding, or ended within DUST_LOOKBACK seconds. */
export interface FxNote {
  id: number;
  midi: number;
  /** key centre x and key width in px */
  x: number;
  w: number;
  black: boolean;
  color: RGB;
  start: number;
  end: number;
  vel: number;
}

export interface FxGeometry {
  width: number;
  height: number;
  /** y of the hit line (top of the keyboard) */
  hitY: number;
  /** keyboard height in px (0 if hidden) */
  kbH: number;
  /** canvas height / 1080 */
  scale: number;
}

/** How long (s) after a note ends its effects (dust) may still be visible. */
export const DUST_LOOKBACK = 3;

/** Coloured light spilling onto played keys. Drawn AFTER the keyboard. */
export function drawKeyLight(ctx: Ctx2D, notes: FxNote[], now: number, g: FxGeometry, s: EffectSettings): void {
  void ctx;
  void notes;
  void now;
  void g;
  void s;
}

/** Starburst flares at the hit line. Drawn after the keyboard (on top). */
export function drawBursts(ctx: Ctx2D, notes: FxNote[], now: number, g: FxGeometry, s: EffectSettings): void {
  void ctx;
  void notes;
  void now;
  void g;
  void s;
}

/** Glittering dust floating up and drifting from played notes. Drawn last. */
export function drawDust(ctx: Ctx2D, notes: FxNote[], now: number, g: FxGeometry, s: EffectSettings): void {
  void ctx;
  void notes;
  void now;
  void g;
  void s;
}
