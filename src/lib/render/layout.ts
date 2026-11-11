import { isBlack, PIANO_MAX, PIANO_MIN } from '../music/theory';
import type { Note } from '../music/types';
import type { KeyboardRange } from './settings';

export interface KeyGeom {
  x: number;
  w: number;
  black: boolean;
}

export interface KeyboardLayout {
  lo: number;
  hi: number;
  keys: (KeyGeom | null)[]; // indexed by midi
  whiteW: number;
  blackW: number;
  width: number;
}

// black-key offsets (fraction of black key width) relative to the boundary between white keys
const BLACK_OFFSET: Record<number, number> = { 1: -0.12, 3: 0.12, 6: -0.15, 8: 0, 10: 0.15 };

const whiteBelowOrEqual = (m: number) => (isBlack(m) ? m - 1 : m);
const whiteAboveOrEqual = (m: number) => (isBlack(m) ? m + 1 : m);

export function rangeFor(range: KeyboardRange, notes: Note[]): [number, number] {
  switch (range) {
    case 'full':
      return [PIANO_MIN, PIANO_MAX];
    case '76':
      return [28, 103]; // E1..G7
    case '61':
      return [36, 96]; // C2..C7
    case '49':
      return [36, 84]; // C2..C6
    case 'auto': {
      if (!notes.length) return [48, 84];
      let lo = 127;
      let hi = 0;
      for (const n of notes) {
        if (n.midi < lo) lo = n.midi;
        if (n.midi > hi) hi = n.midi;
      }
      // pad to whole octaves (C..B), at least 2 octaves wide
      lo = Math.max(PIANO_MIN, Math.floor(lo / 12) * 12);
      hi = Math.min(PIANO_MAX, Math.ceil((hi + 1) / 12) * 12 - 1);
      while (hi - lo < 23) {
        if (lo > PIANO_MIN) lo = Math.max(PIANO_MIN, lo - 12);
        if (hi - lo < 23 && hi < PIANO_MAX) hi = Math.min(PIANO_MAX, hi + 12);
        if (lo === PIANO_MIN && hi === PIANO_MAX) break;
      }
      return [lo, hi];
    }
  }
}

export function computeLayout(width: number, lo: number, hi: number): KeyboardLayout {
  lo = whiteBelowOrEqual(lo);
  hi = whiteAboveOrEqual(hi);
  let whites = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites++;
  const whiteW = width / whites;
  const blackW = whiteW * 0.6;
  const keys: (KeyGeom | null)[] = new Array(128).fill(null);
  let wi = 0;
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) {
      keys[m] = { x: wi * whiteW, w: whiteW, black: false };
      wi++;
    } else {
      const boundary = wi * whiteW;
      const off = BLACK_OFFSET[m % 12] ?? 0;
      keys[m] = { x: boundary - blackW / 2 + off * blackW, w: blackW, black: true };
    }
  }
  return { lo, hi, keys, whiteW, blackW, width };
}

export function midiAtX(layout: KeyboardLayout, x: number, preferBlack = true): number | null {
  if (preferBlack) {
    for (let m = layout.lo; m <= layout.hi; m++) {
      const k = layout.keys[m];
      if (k?.black && x >= k.x && x < k.x + k.w) return m;
    }
  }
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    if (k && !k.black && x >= k.x && x < k.x + k.w) return m;
  }
  return null;
}
