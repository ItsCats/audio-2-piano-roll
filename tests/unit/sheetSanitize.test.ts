/** Sheet-edit data from storage or a project file: hostile input never throws, bad fields are dropped. */
import { describe, expect, it } from 'vitest';
import type { Song } from '../../src/lib/music/types';
import { sanitizeSheetData } from '../../src/lib/sheet/sanitize';
import { buildSheet, toMusicXml } from '../../src/lib/sheet';
import { ensureSheet } from '../../src/lib/sheet/lock';
import { straightSong } from './sheetSongs';

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}
const junk = (r: () => number, depth = 0): unknown => {
  const k = Math.floor(r() * 12);
  if (depth > 3) return [null, 1, 'x', NaN, -1, Infinity][k % 6];
  switch (k) {
    case 0: return null;
    case 1: return undefined;
    case 2: return NaN;
    case 3: return -5;
    case 4: return 'boom';
    case 5: return [junk(r, depth + 1), junk(r, depth + 1)];
    case 6: return { v: 1, grid: junk(r, depth + 1) };
    case 7: return { beats: [0, 1, 1], db: 0, bpm: 120, beatsPerBar: 4, beatUnit: 4, originQ: 0, pickup: 0 };
    case 8: return 1e308;
    case 9: return { on: junk(r, depth + 1), off: 3, t: 0, d: 1 };
    case 10: return true;
    default: return { __proto__: null, x: junk(r, depth + 1) };
  }
};

describe('sheet data sanitizer', () => {
  it('keeps valid data unchanged', () => {
    const s = straightSong();
    const song: Song = { ...s, sheet: { ...ensureSheet(s, 'hard'), bars: 20 } };
    const n = song.arrangements.hard.notes[0];
    song.arrangements.hard.notes[0] = { ...n, pin: { on: 0, off: 6, t: n.start, d: n.dur } };
    const copy = structuredClone(song);
    sanitizeSheetData(copy);
    expect(copy.sheet).toEqual(song.sheet);
    expect(copy.arrangements.hard.notes[0].pin).toEqual(song.arrangements.hard.notes[0].pin);
  });

  it('drops a damaged lock with every pin; an old song is untouched', () => {
    const s = straightSong();
    const old = structuredClone(s);
    sanitizeSheetData(old);
    expect('sheet' in old).toBe(false);
    expect(toMusicXml(buildSheet(old, 'hard'), { title: 'x', date: 'd' })).toBe(toMusicXml(buildSheet(s, 'hard'), { title: 'x', date: 'd' }));
    for (const bad of [{ v: 2, grid: ensureSheet(s, 'hard').grid }, { v: 1, grid: { ...ensureSheet(s, 'hard').grid, beats: [1, 0.5] } }, { v: 1, grid: { ...ensureSheet(s, 'hard').grid, bpm: 9000 } }, { v: 1 }, 'x', 5]) {
      const song = structuredClone(s) as Song & { sheet: unknown };
      song.sheet = bad;
      song.arrangements.easy.notes[0].pin = { on: 0, off: 6, t: 0, d: 1 };
      sanitizeSheetData(song);
      expect('sheet' in song).toBe(false);
      expect('pin' in song.arrangements.easy.notes[0]).toBe(false);
    }
  });

  it('hostile JSON never throws; whatever stays is valid', () => {
    const r = rng(3);
    const s = straightSong();
    for (let i = 0; i < 400; i++) {
      const song = structuredClone(s) as unknown as Record<string, unknown> & Song;
      (song as { sheet?: unknown }).sheet = i % 3 ? junk(r) : { v: 1, grid: { ...ensureSheet(s, 'hard').grid, ...(i % 2 ? { pickup: junk(r) } : {}) }, bars: junk(r) };
      const notes = song.arrangements.medium.notes as unknown as Record<string, unknown>[];
      for (let j = 0; j < 5; j++) notes[j].pin = junk(r);
      if (i % 7 === 0) (song.arrangements as unknown as Record<string, unknown>).hard = junk(r);
      expect(() => sanitizeSheetData(song)).not.toThrow();
      if (song.sheet) {
        expect(song.sheet.v).toBe(1);
        expect(song.sheet.grid.beats.length).toBeGreaterThanOrEqual(2);
        if ('bars' in song.sheet) expect(Number.isInteger(song.sheet.bars)).toBe(true);
      }
      for (const n of song.arrangements.medium.notes) if (n.pin) expect(n.pin.off).toBeGreaterThan(n.pin.on);
    }
  });
});
