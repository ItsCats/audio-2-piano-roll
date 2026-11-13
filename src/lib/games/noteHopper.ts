/**
 * "Note Hopper": a music note hops through the gaps between key-shaped bars; every gap passed plays
 * the next note of a tune. Game rules only (no DOM): the world is HOPPER_H units tall and as wide as
 * the screen's aspect ratio makes it; time is in seconds. The state is changed in place (no garbage
 * per frame), and everything is deterministic for a given seed.
 */
import { makeRng, nextRandom, type Rng } from './rng';
import { melodyCursor, nextNote, type MelodyCursor } from './melodies';

export const HOPPER_H = 100;
/** the keyboard strip along the bottom starts here; touching it ends the run */
export const HOPPER_FLOOR = 90;
/** fixed physics step */
export const HOPPER_DT = 1 / 120;

export interface HopperConfig {
  /** world width in units (height is HOPPER_H) */
  width: number;
  gravity: number;
  /** upward speed right after a hop */
  hopSpeed: number;
  /** fastest fall */
  maxFall: number;
  baseSpeed: number;
  maxSpeed: number;
  speedPerPoint: number;
  barWidth: number;
  /** distance between one bar and the next */
  spacing: number;
  gapStart: number;
  gapMin: number;
  gapShrinkPerPoint: number;
  radius: number;
  /** the note's fixed horizontal position */
  x: number;
}

export function hopperConfig(width: number, reducedMotion = false): HopperConfig {
  const w = Math.max(40, width);
  return {
    width: w,
    gravity: reducedMotion ? 210 : 250,
    hopSpeed: reducedMotion ? 68 : 76,
    maxFall: 110,
    baseSpeed: reducedMotion ? 19 : 25,
    maxSpeed: reducedMotion ? 28 : 40,
    speedPerPoint: reducedMotion ? 0.35 : 0.6,
    barWidth: 10,
    spacing: 40,
    gapStart: reducedMotion ? 38 : 35,
    gapMin: reducedMotion ? 30 : 26,
    gapShrinkPerPoint: 0.35,
    radius: 3.2,
    x: Math.min(w * 0.3, 32),
  };
}

/** scroll speed (units per second) at a score */
export function hopperSpeed(score: number, cfg: HopperConfig): number {
  return Math.min(cfg.maxSpeed, cfg.baseSpeed + score * cfg.speedPerPoint);
}

/** size of the next gap at a score */
export function gapSize(score: number, cfg: HopperConfig): number {
  return Math.max(cfg.gapMin, cfg.gapStart - score * cfg.gapShrinkPerPoint);
}

export interface Bar {
  x: number;
  /** gap center */
  gapY: number;
  gap: number;
  passed: boolean;
  /** the note played when this bar was passed (for the key light-up) */
  pitch: number;
}

export type HopperPhase = 'ready' | 'playing' | 'over';

export interface HopperState {
  phase: HopperPhase;
  y: number;
  vy: number;
  score: number;
  bars: Bar[];
  /** hops waiting for the next step (the input queue) */
  hops: number;
  /** simulated seconds */
  time: number;
  rng: Rng;
  tune: MelodyCursor;
  /** the last note played and when (for the key light-up) */
  lastPitch: number | null;
  lastPitchAt: number;
  /** leftover time not yet simulated */
  acc: number;
}

/** where the first bar is when a run starts (the rest follow every `spacing` units to the right edge) */
export const FIRST_BAR_AHEAD = 55;

export function newHopper(cfg: HopperConfig, seed: number, tune = 0): HopperState {
  const s: HopperState = {
    phase: 'ready',
    y: HOPPER_FLOOR * 0.45,
    vy: 0,
    score: 0,
    bars: [],
    hops: 0,
    time: 0,
    rng: makeRng(seed),
    tune: melodyCursor(tune),
    lastPitch: null,
    lastPitchAt: -1,
    acc: 0,
  };
  fillBars(s, cfg);
  return s;
}

/** Add bars up to just past the right edge (the first one FIRST_BAR_AHEAD units ahead of the note). */
function fillBars(s: HopperState, cfg: HopperConfig) {
  if (!s.bars.length) spawnBar(s, cfg, cfg.x + FIRST_BAR_AHEAD);
  for (;;) {
    const last = s.bars[s.bars.length - 1].x;
    if (last > cfg.width + 2 - cfg.spacing) return;
    spawnBar(s, cfg, last + cfg.spacing);
  }
}

/** Queue a hop (tap, click, Space). Ignored after the run ended. */
export function queueHop(s: HopperState): void {
  if (s.phase === 'over') return;
  if (s.phase === 'ready') s.phase = 'playing';
  // more than two hops between steps would be a stuck key or a burst of taps
  if (s.hops < 2) s.hops++;
}

/** Circle against an axis-aligned rectangle. */
export function circleHitsRect(cx: number, cy: number, r: number, x: number, y: number, w: number, h: number): boolean {
  const nx = Math.max(x, Math.min(cx, x + w));
  const ny = Math.max(y, Math.min(cy, y + h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** whether the note touches a bar (above or below its gap) */
export function hitsBar(y: number, cfg: HopperConfig, bar: Bar): boolean {
  const top = bar.gapY - bar.gap / 2;
  const bottom = bar.gapY + bar.gap / 2;
  return circleHitsRect(cfg.x, y, cfg.radius, bar.x, -50, cfg.barWidth, top + 50) || circleHitsRect(cfg.x, y, cfg.radius, bar.x, bottom, cfg.barWidth, HOPPER_FLOOR - bottom);
}

export type HopperEvent = 'hop' | 'pass' | 'crash';

function spawnBar(s: HopperState, cfg: HopperConfig, x: number) {
  const gap = gapSize(s.score, cfg);
  const margin = 8;
  const lo = margin + gap / 2;
  const hi = HOPPER_FLOOR - margin - gap / 2;
  // not too far from the previous gap, so every layout can be flown
  const prev = s.bars.length ? s.bars[s.bars.length - 1].gapY : (lo + hi) / 2;
  const reach = 34;
  const a = Math.max(lo, prev - reach);
  const b = Math.min(hi, prev + reach);
  const gapY = a + nextRandom(s.rng) * Math.max(0, b - a);
  const bar = s.bars.length && s.bars[0].x + cfg.barWidth < -2 ? s.bars.shift()! : ({} as Bar);
  bar.x = x;
  bar.gapY = gapY;
  bar.gap = gap;
  bar.passed = false;
  bar.pitch = 0;
  s.bars.push(bar);
}

/** One fixed physics step. Events are pushed to `out` (not allocated per step). */
export function stepHopperOnce(s: HopperState, cfg: HopperConfig, out: HopperEvent[]): void {
  s.time += HOPPER_DT;
  if (s.phase !== 'playing') return;
  if (s.hops > 0) {
    s.hops--;
    s.vy = -cfg.hopSpeed;
    out.push('hop');
  }
  s.vy = Math.min(cfg.maxFall, s.vy + cfg.gravity * HOPPER_DT);
  s.y += s.vy * HOPPER_DT;
  if (s.y < cfg.radius) {
    s.y = cfg.radius;
    s.vy = 0;
  }
  const dx = hopperSpeed(s.score, cfg) * HOPPER_DT;
  for (const bar of s.bars) bar.x -= dx;
  fillBars(s, cfg);
  for (const bar of s.bars) {
    if (!bar.passed && bar.x + cfg.barWidth < cfg.x - cfg.radius) {
      bar.passed = true;
      s.score++;
      const n = nextNote(s.tune);
      s.tune = n.cursor;
      bar.pitch = n.pitch;
      s.lastPitch = n.pitch;
      s.lastPitchAt = s.time;
      out.push('pass');
    }
  }
  let crashed = s.y + cfg.radius >= HOPPER_FLOOR;
  if (!crashed) for (const bar of s.bars) if (bar.x < cfg.x + cfg.radius && bar.x + cfg.barWidth > cfg.x - cfg.radius && hitsBar(s.y, cfg, bar)) crashed = true;
  if (crashed) {
    s.phase = 'over';
    s.y = Math.min(s.y, HOPPER_FLOOR - cfg.radius);
    s.hops = 0;
    out.push('crash');
  }
}

/** Advance by `dt` seconds of real time (at most 0.1 s at once: a long frame doesn't jump ahead). */
export function stepHopper(s: HopperState, cfg: HopperConfig, dt: number, out: HopperEvent[]): void {
  s.acc += Math.min(0.1, Math.max(0, dt));
  while (s.acc >= HOPPER_DT) {
    s.acc -= HOPPER_DT;
    stepHopperOnce(s, cfg, out);
  }
}

/** Fit a game to a new world width (the screen turned or resized): keep the bars, add more if it got wider. */
export function resizeHopper(s: HopperState, cfg: HopperConfig): void {
  fillBars(s, cfg);
}
