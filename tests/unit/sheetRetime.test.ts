/** Tempo marks that re-time the music (lib/sheet/retime.ts): positions never change, only seconds. */
import { describe, expect, it } from 'vitest';
import type { Song } from '../../src/lib/music/types';
import { buildSheet } from '../../src/lib/sheet';
import { ensureSheet } from '../../src/lib/sheet/lock';
import { gridFromLock } from '../../src/lib/sheet/grid';
import { canRetime, retime } from '../../src/lib/sheet/retime';
import { DIV } from '../../src/lib/sheet/types';
import { GOLDEN_SONGS } from './sheetSongs';

const locked = (song: Song): Song => ({ ...song, sheet: ensureSheet(song, 'hard') });

describe('retime', () => {
  for (const [name, make] of GOLDEN_SONGS) {
    for (const [pos0Bar, qpm] of [
      [0, 90],
      [3, 140],
      [5, 40],
    ] as const) {
      it(`${name}: from bar ${pos0Bar} at ${qpm}: every note, pedal, pin and beat keeps its position`, () => {
        const song = locked(make());
        const before = gridFromLock(song.sheet!.grid, song.tempo.source);
        const pos0 = before.measureStart(pos0Bar);
        const { patch, f } = retime(song, pos0, qpm);
        const after = gridFromLock(patch.sheet!.grid, song.tempo.source);
        const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);
        for (const lv of ['easy', 'medium', 'hard'] as const) {
          const old = song.arrangements[lv];
          const neu = patch.arrangements[lv];
          old.notes.forEach((n, i) => {
            near(after.toPos(neu.notes[i].start), before.toPos(n.start));
            near(after.toPos(neu.notes[i].start + neu.notes[i].dur), before.toPos(n.start + n.dur));
          });
          old.pedal.forEach((p, i) => near(after.toPos(neu.pedal[i].start), before.toPos(p.start)));
        }
        song.tempo.beats.forEach((b, i) => near(after.toPos(patch.tempo.beats[i]), before.toPos(b)));
        near(after.toPos(patch.duration), before.toPos(song.duration));
        // seconds before pos0 are unchanged; the measure after pos0 lasts its length at the new tempo
        expect(f(before.posToTime(pos0) - 0.01)).toBe(before.posToTime(pos0) - 0.01);
        const m = pos0Bar + 1;
        const secs = after.posToTime(after.measureStart(m + 1)) - after.posToTime(after.measureStart(m));
        expect(secs).toBeCloseTo(((after.measureStart(m + 1) - after.measureStart(m)) / DIV) * (60 / qpm), 6);
      });
    }
  }

  it('keeps pins valid and the written sheet the same', () => {
    const song = locked(GOLDEN_SONGS[0][1]());
    const n = song.arrangements.hard.notes[10];
    const score0 = buildSheet(song, 'hard');
    const pinned: Song = { ...song, arrangements: { ...song.arrangements, hard: { ...song.arrangements.hard, notes: song.arrangements.hard.notes.map((x) => (x.id === n.id ? { ...x, pin: { on: 30, off: 33, t: x.start, d: x.dur } } : x)) } } };
    const { patch } = retime(pinned, 0, 100);
    const p = patch.arrangements.hard.notes.find((x) => x.id === n.id)!;
    expect(p.pin!.t).toBe(p.start);
    expect(p.pin!.d).toBe(p.dur);
    const s1 = buildSheet({ ...song, ...patch }, 'hard');
    const s0 = buildSheet({ ...song, ...retime(song, 0, 100).patch }, 'hard');
    expect(s0.notes.map((x) => [x.midi, x.on, x.off])).toEqual(score0.notes.map((x) => [x.midi, x.on, x.off]));
    expect(s1.measureCount).toBe(score0.measureCount);
  });

  it('is refused with a recording or a hands video', () => {
    const s = GOLDEN_SONGS[0][1]();
    expect(canRetime(s)).toBe(true);
    expect(canRetime({ ...s, hasAudio: true })).toBe(false);
    expect(canRetime({ ...s, handVideo: {} as Song['handVideo'] })).toBe(false);
  });
});
