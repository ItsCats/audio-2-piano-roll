/** Sheet grid lock: the locked grid is the TimeMap on screen, and edits under it never re-bar. */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type Song } from '../../src/lib/music/types';
import { buildSheet } from '../../src/lib/sheet';
import { gridFromLock } from '../../src/lib/sheet/grid';
import { ensureSheet, lockGrid } from '../../src/lib/sheet/lock';
import { GOLDEN_SONGS } from './sheetSongs';

describe('sheet grid lock', () => {
  for (const [name, make] of GOLDEN_SONGS) {
    const song = make();
    for (const d of DIFFICULTIES) {
      it(`${name} ${d}: reproduces toPos / posToTime at 1,000 times`, () => {
        const t = buildSheet(song, d).time;
        const lock = lockGrid(song, d);
        const l = gridFromLock(lock, t.source);
        for (let i = 0; i < 1000; i++) {
          const x = -2 + (i / 999) * (song.duration + 6);
          expect(l.toPos(x)).toBe(t.toPos(x));
          const p = i * 7 - 40;
          expect(l.posToTime(p)).toBe(t.posToTime(p));
        }
        expect([l.measureLen, l.pickup, l.beatLen, l.compound, l.bpm]).toEqual([t.measureLen, t.pickup, t.beatLen, t.compound, t.bpm]);
        // the locked sheet is the same sheet
        const locked: Song = { ...song, sheet: ensureSheet(song, d) };
        expect(buildSheet(locked, d).measureStartTimes).toEqual(buildSheet(song, d).measureStartTimes);
      });
    }
  }

  it('deleting the first note or adding one before it keeps every measure start', () => {
    for (const [, make] of GOLDEN_SONGS) {
      const song = make();
      const d = 'medium' as const;
      const locked: Song = { ...song, sheet: ensureSheet(song, d) };
      const before = buildSheet(locked, d);
      const notes = locked.arrangements[d].notes;
      const firstStart = Math.min(...notes.map((n) => n.start));
      const variants = [
        notes.filter((n) => n.start > firstStart + 1e-6),
        [...notes, { ...notes[0], id: 999999, start: Math.max(0, firstStart - 0.4), dur: 0.2 }],
      ];
      for (const v of variants) {
        const s: Song = { ...locked, arrangements: { ...locked.arrangements, [d]: { ...locked.arrangements[d], notes: v } } };
        const after = buildSheet(s, d);
        const n = Math.min(before.measureCount, after.measureCount);
        for (let m = 0; m <= n; m++) expect(after.time.measureStart(m)).toBe(before.time.measureStart(m));
        expect(after.measureStartTimes.slice(0, n)).toEqual(before.measureStartTimes.slice(0, n));
      }
    }
  });
});
