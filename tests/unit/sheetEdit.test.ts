/** Sheet editing: ids through the pipeline, pins, edit operations, pitch steps and staff positions. */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type Difficulty, type Note, type Song } from '../../src/lib/music/types';
import { regularBeats } from '../../src/lib/music/beats';
import { buildSheet, toMusicXml } from '../../src/lib/sheet';
import { ensureSheet } from '../../src/lib/sheet/lock';
import { writtenIndex, writtenSpan } from '../../src/lib/sheet/written';
import { pinValid } from '../../src/lib/sheet/score';
import {
  addBarOp,
  addOp,
  deleteOp,
  gridStep,
  handOp,
  lengthOp,
  moveOp,
  pitchOp,
  resolveOverlaps,
  spanOf,
  tieOp,
  tieState,
  type SheetCtx,
} from '../../src/lib/sheet/edit';
import { alterAt, diatonicAtY, diatonicToMidi, pitchLabel, stepInKey, yOfDiatonic } from '../../src/lib/sheet/pitch';
import { diatonic, spell } from '../../src/lib/sheet/spelling';
import { DIV } from '../../src/lib/sheet/types';
import { GOLDEN_SONGS, straightSong } from './sheetSongs';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const locked = (song: Song, d: Difficulty): Song => ({ ...song, sheet: ensureSheet(song, d) });
const ctxOf = (song: Song, d: Difficulty): SheetCtx => ({ song, level: d, score: buildSheet(song, d) });
/** The song with a level's notes replaced (as the store does after an edit). */
const apply = (ctx: SheetCtx, notes: Note[], extra: Partial<Song> = {}): Song => ({
  ...ctx.song,
  ...extra,
  arrangements: { ...ctx.song.arrangements, [ctx.level]: { ...ctx.song.arrangements[ctx.level], notes: [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi), edited: true } },
});

/** A plain song in 4/4 at 120 BPM (a quarter = 0.5 s) with the given notes, its grid locked. */
function plain(notes: Omit<Note, 'vel'>[], level: Difficulty = 'medium', fifths?: { tonic: number; mode: 'major' | 'minor' }): Song {
  const base = straightSong();
  const ns = notes.map((n) => ({ vel: 0.7, ...n }));
  const song: Song = {
    ...base,
    duration: 16,
    base: ns,
    key: fifths ? { ...fifths, name: '', confidence: 1 } : { tonic: 0, mode: 'major', name: 'C major', confidence: 1 },
    tempo: { bpm: 120, beats: regularBeats(120, 0, 20), beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'midi' },
    arrangements: { easy: { notes: ns, pedal: [], edited: false, generatedAt: 0 }, medium: { notes: ns, pedal: [], edited: false, generatedAt: 0 }, hard: { notes: ns, pedal: [], edited: false, generatedAt: 0 } },
  };
  return locked(song, level);
}
const q = 0.5;

describe('sheet source ids', () => {
  for (const [name, make] of GOLDEN_SONGS) {
    const song = make();
    for (const d of DIFFICULTIES) {
      it(`${name} ${d}: every note is written, every written note has a note`, () => {
        const score = buildSheet(song, d);
        const idx = writtenIndex(score);
        for (const n of song.arrangements[d].notes) expect(idx.byId.has(n.id), `note ${n.id}`).toBe(true);
        for (const w of idx.byKey.values()) expect(w.ids.length).toBeGreaterThan(0);
        // the index walks exactly what the MusicXML writes
        const xml = toMusicXml(score, { title: '' });
        expect(idx.byKey.size).toBe((xml.match(/<pitch>/g) ?? []).length);
      });
    }
  }
});

describe('sheet pins', () => {
  it('random pins on the level grid are written exactly there, and none is dropped', () => {
    const r = rng(11);
    for (const d of DIFFICULTIES) {
      for (let trial = 0; trial < 12; trial++) {
        const base = straightSong();
        const song0 = locked(base, d);
        const score0 = buildSheet(song0, d);
        const t = score0.time;
        const step = d === 'easy' ? 6 : 3;
        const notes: Note[] = [];
        const pins: Note[] = [];
        let id = 500000 + trial * 1000;
        for (const hand of ['R', 'L'] as const) {
          let pos = Math.floor(r() * 8) * step;
          while (pos < 12 * DIV * 4) {
            const len = (1 + Math.floor(r() * (d === 'easy' ? 6 : 10))) * step;
            const on = pos;
            const off = on + len;
            const start = t.posToTime(on);
            const dur = t.posToTime(off) - start;
            const n: Note = { id: id++, midi: (hand === 'R' ? 64 : 45) + Math.floor(r() * 12), start, dur, vel: 0.7, hand, pin: { on, off, t: start, d: dur } };
            pins.push(n);
            notes.push(n);
            pos = off + Math.floor(r() * 3) * step;
          }
          // played notes around them (Medium and Hard: they take the second voice or are cut)
          if (d !== 'easy')
            for (let i = 0; i < 20; i++) {
              const start = r() * 22;
              notes.push({ id: id++, midi: (hand === 'R' ? 60 : 40) + Math.floor(r() * 20), start, dur: 0.1 + r() * 1.2, vel: 0.6, hand });
            }
        }
        const song: Song = { ...song0, arrangements: { ...song0.arrangements, [d]: { ...song0.arrangements[d], notes } } };
        const score = buildSheet(song, d);
        for (const p of pins) {
          const w = writtenSpan(score, p.id);
          expect(w, `${d} pinned note ${p.id}`).not.toBeNull();
          expect([w!.on, w!.off], `${d} pinned note ${p.id}`).toEqual([p.pin!.on, p.pin!.off]);
        }
        for (const n of notes) expect(writtenIndex(score).byId.has(n.id)).toBe(true);
      }
    }
  });

  it('a piano-roll move or resize releases the pin; transposing keeps it', () => {
    const n: Note = { id: 1, midi: 60, start: 1, dur: 0.5, vel: 0.7, hand: 'R', pin: { on: 24, off: 30, t: 1, d: 0.5 } };
    expect(pinValid(n)).toBe(true);
    expect(pinValid({ ...n, start: 1.01 })).toBe(false);
    expect(pinValid({ ...n, dur: 0.6 })).toBe(false);
    expect(pinValid({ ...n, midi: 62 })).toBe(true);
    expect(pinValid({ ...n, hand: 'L' })).toBe(true);
    // the sheet then writes the moved note where it now sounds
    const song = plain([{ id: 1, midi: 60, start: 1, dur: 0.5, hand: 'R' }]);
    const moved = apply(ctxOf(song, 'medium'), [{ ...n, start: 2, dur: 0.5 }]);
    expect(writtenSpan(buildSheet(moved, 'medium'), 1)).toMatchObject({ on: 48, off: 60 });
  });
});

describe('sheet edit operations', () => {
  const base = () =>
    plain([
      { id: 1, midi: 60, start: 0, dur: q, hand: 'R' },
      { id: 2, midi: 64, start: q, dur: q, hand: 'R' },
      { id: 3, midi: 67, start: 2 * q, dur: 2 * q, hand: 'R' },
      { id: 4, midi: 48, start: 0, dur: 4 * q, hand: 'L' },
    ]);

  it('pitch: a step in the key, an octave, a semitone; the note stays where it is written', () => {
    const ctx = ctxOf(base(), 'medium');
    const up = pitchOp(ctx, new Set([2]), 'step', 1)!;
    expect(up.notes.find((n) => n.id === 2)).toMatchObject({ midi: 65, start: q, dur: q });
    expect(pitchOp(ctx, new Set([2]), 'octave', -1)!.notes.find((n) => n.id === 2)!.midi).toBe(52);
    expect(pitchOp(ctx, new Set([2]), 'semi', 1)!.notes.find((n) => n.id === 2)!.midi).toBe(65);
    expect(pitchOp(ctx, new Set([1]), 'semi', 1)!.notes.find((n) => n.id === 1)!.midi).toBe(61);
    const pinned = up.notes.find((n) => n.id === 2)!;
    expect(pinValid(pinned) && pinned.pin).toMatchObject({ on: 12, off: 24 });
  });

  it('move: by a grid step or a beat, at exactly posToTime of the new place, keeping the length', () => {
    const ctx = ctxOf(base(), 'medium');
    const t = ctx.score.time;
    const later = moveOp(ctx, new Set([2]), 1)!.notes.find((n) => n.id === 2)!;
    expect(later.start).toBe(t.posToTime(15));
    expect(later.dur).toBe(t.posToTime(27) - t.posToTime(15));
    expect(later.pin).toMatchObject({ on: 15, off: 27 });
    const beat = moveOp(ctx, new Set([2]), -1, true)!.notes.find((n) => n.id === 2)!;
    expect(beat.pin).toMatchObject({ on: 0, off: 12 });
    // the same pitch at the same place: none here (64 vs 60), so nothing is removed
    expect(moveOp(ctx, new Set([2]), -1, true)!.notes).toHaveLength(4);
    expect(moveOp(ctx, new Set([1]), -1)).toBeNull(); // never before the start
    // Easy moves by 8ths (one voice: the moved note stops where the next one starts)
    const easy = ctxOf(locked(base(), 'easy'), 'easy');
    expect(moveOp(easy, new Set([2]), 1)!.notes.find((n) => n.id === 2)!.pin).toMatchObject({ on: 18, off: 24 });
  });

  it('length: palette, shorter / longer, dot, triplet; following notes stay', () => {
    const ctx = ctxOf(base(), 'medium');
    const t = ctx.score.time;
    const half = lengthOp(ctx, new Set([1]), { len: 24 })!;
    expect(half.notes.find((n) => n.id === 1)!.dur).toBe(t.posToTime(24) - t.posToTime(0));
    expect(half.notes.find((n) => n.id === 2)!.start).toBe(q);
    expect(lengthOp(ctx, new Set([1]), { step: 1 })!.notes.find((n) => n.id === 1)!.pin).toMatchObject({ off: 18 });
    expect(lengthOp(ctx, new Set([1]), { step: -1 })!.notes.find((n) => n.id === 1)!.pin).toMatchObject({ off: 9 });
    expect(lengthOp(ctx, new Set([1]), { dot: true })!.notes.find((n) => n.id === 1)!.pin).toMatchObject({ off: 18 });
    expect(lengthOp(ctx, new Set([1]), { triplet: true })!.notes.find((n) => n.id === 1)!.pin).toMatchObject({ off: 8 });
    // Easy: no 16ths, no triplets
    const easy = ctxOf(locked(base(), 'easy'), 'easy');
    expect(lengthOp(easy, new Set([1]), { step: -1 })!.notes.find((n) => n.id === 1)!.pin).toMatchObject({ off: 6 });
    expect(lengthOp(easy, new Set([1]), { triplet: true })).toBeNull();
  });

  it("a song's first edit (no grid lock yet) follows the same overlap rules as later ones", () => {
    // C4 quarter, then C4 quarter: making the first one longer cuts it where the second starts
    const notes = [
      { id: 1, midi: 60, start: 0, dur: q, hand: 'R' as const },
      { id: 2, midi: 60, start: q, dur: q, hand: 'R' as const },
    ];
    const lockedSong = plain(notes);
    const { sheet: _sheet, ...unlocked } = lockedSong;
    void _sheet;
    for (const song of [unlocked as Song, lockedSong]) {
      const res = lengthOp(ctxOf(song, 'medium'), new Set([1]), { step: 1 })!;
      const n1 = res.notes.find((n) => n.id === 1)!;
      expect(n1.pin, song.sheet ? 'locked' : 'first edit').toMatchObject({ on: 0, off: 12 });
      expect(n1.start + n1.dur).toBeCloseTo(q, 9);
      expect(res.notes.map((n) => n.id)).toEqual([1, 2]);
      // a half note covers the second one: it goes
      expect(lengthOp(ctxOf(song, 'medium'), new Set([1]), { len: 24 })!.notes.map((n) => n.id)).toEqual([1]);
    }
  });

  it('delete, add (a chord tone at an existing onset), hand', () => {
    const ctx = ctxOf(base(), 'medium');
    expect(deleteOp(ctx, new Set([2]))!.notes.map((n) => n.id)).toEqual([1, 3, 4]);
    const add = addOp(ctx, { pos: 12, midi: 67, staff: 1, len: 12 })!;
    const added = add.notes.find((n) => n.id === add.select![0])!;
    expect(added).toMatchObject({ midi: 67, hand: 'R', start: ctx.score.time.posToTime(12) });
    const s2 = apply(ctx, add.notes);
    const sc2 = buildSheet(s2, 'medium');
    const w = writtenIndex(sc2).byId.get(added.id)![0];
    expect(w.inChord).toBe(true);
    expect(w.chordOn).toBe(12);
    const toLeft = handOp(ctx, new Set([2]), 'toggle')!;
    const moved = toLeft.notes.find((n) => n.id === 2)!;
    expect(moved.hand).toBe('L');
    expect(writtenSpan(buildSheet(apply(ctx, toLeft.notes), 'medium'), 2)).toMatchObject({ on: 12, off: 24, staff: 2 });
  });

  it('an edit past the end raises the duration to the end of that measure; Add bar adds a measure', () => {
    const ctx = ctxOf(base(), 'medium');
    const t = ctx.score.time;
    const far = addOp(ctx, { pos: t.measureStart(9) + 12, midi: 60, staff: 1, len: 12 })!;
    expect(far.duration).toBe(t.posToTime(t.measureStart(10)));
    const bar = addBarOp(ctx);
    expect(bar.bars).toBe(ctx.score.measureCount + 1);
    const s2 = apply(ctx, bar.notes, { sheet: { ...ctx.song.sheet!, bars: bar.bars }, ...(bar.duration ? { duration: bar.duration } : {}) });
    expect(buildSheet(s2, 'medium').measureCount).toBe(ctx.score.measureCount + 1);
  });

  it('same hand and pitch: the earlier note is cut, a covered one removed', () => {
    const song = plain([
      { id: 1, midi: 60, start: 0, dur: 4 * q, hand: 'R' },
      { id: 2, midi: 60, start: 4 * q, dur: q, hand: 'R' },
    ]);
    const ctx = ctxOf(song, 'medium');
    // id 2 moved one beat earlier: id 1 now ends where it starts
    const r = moveOp(ctx, new Set([2]), -1, true)!;
    expect(r.notes.find((n) => n.id === 1)!.pin).toMatchObject({ on: 0, off: 36 });
    // lengthened over a later same pitch that it covers: that one goes
    const ctx2 = ctxOf(
      plain([
        { id: 1, midi: 60, start: 0, dur: q, hand: 'R' },
        { id: 2, midi: 60, start: q, dur: q, hand: 'R' },
      ]),
      'medium',
    );
    expect(lengthOp(ctx2, new Set([1]), { len: 48 })!.notes.map((n) => n.id)).toEqual([1]);
  });

  it('Easy: a touched note cuts a same-hand note sounding into it and stops at the next onset', () => {
    const song = plain(
      [
        { id: 1, midi: 60, start: 0, dur: 4 * q, hand: 'R' },
        { id: 2, midi: 67, start: 2 * q, dur: q, hand: 'R' },
        { id: 3, midi: 64, start: 3 * q, dur: q, hand: 'R' },
      ],
      'easy',
    );
    const ctx = ctxOf(song, 'easy');
    const r = resolveOverlaps(ctx, ctx.song.arrangements.easy.notes, new Set([2]));
    expect(spanOf(ctx, r.find((n) => n.id === 1)!)).toMatchObject({ on: 0, off: 24 });
    const longer = lengthOp(ctx, new Set([2]), { len: 24 })!;
    expect(longer.notes.find((n) => n.id === 2)!.pin).toMatchObject({ on: 24, off: 36 });
  });

  it('tie merges two notes into one; untie splits at the piece boundary', () => {
    const song = plain([
      { id: 1, midi: 62, start: 0, dur: 2 * q, hand: 'R' },
      { id: 2, midi: 62, start: 2 * q, dur: 2 * q, hand: 'R' },
    ]);
    const ctx = ctxOf(song, 'medium');
    expect(tieState(ctx, new Set([1, 2]))).toBe('tie');
    const tied = tieOp(ctx, new Set([1, 2]))!;
    expect(tied.notes).toHaveLength(1);
    expect(tied.notes[0]).toMatchObject({ id: 1, start: 0, dur: 4 * q });
    expect(tied.notes[0].pin).toMatchObject({ on: 0, off: 48 });
    // a note across the bar line is written as two tied pieces
    const across = plain([{ id: 5, midi: 62, start: 3 * q, dur: 2 * q, hand: 'R' }]);
    const c2 = ctxOf(across, 'medium');
    expect(tieState(c2, new Set([5]))).toBe('untie');
    const split = tieOp(c2, new Set([5]))!;
    expect(split.notes).toHaveLength(2);
    expect(split.notes.map((n) => n.pin && [n.pin.on, n.pin.off])).toEqual([
      [36, 48],
      [48, 60],
    ]);
    expect(split.notes[1].start).toBe(c2.score.time.posToTime(48));
  });

  it('grid steps: 16ths on Medium, triplet 8ths inside a triplet quarter, 8ths on Easy', () => {
    const ctx = ctxOf(base(), 'medium');
    expect(gridStep(ctx.score, 0)).toBe(3);
    const tri = { ...ctx.score, tripletQuarters: new Set([2]) };
    expect(gridStep(tri, 24)).toBe(4);
    expect(gridStep({ ...ctx.score, level: 'easy' }, 0)).toBe(6);
  });
});

describe('sheet pitch', () => {
  it('steps in the key: C major, D major, B♭ minor', () => {
    expect(stepInKey(60, 1, 0)).toBe(62);
    expect(stepInKey(64, 1, 0)).toBe(65);
    expect(stepInKey(66, 1, 0)).toBe(67); // F♯ → G
    expect(stepInKey(66, -1, 0)).toBe(64); // F♯ → E
    expect(stepInKey(62, 1, 2)).toBe(64); // D → E
    expect(stepInKey(64, 1, 2)).toBe(66); // E → F♯
    expect(stepInKey(71, 1, 2)).toBe(73); // B → C♯
    expect(stepInKey(70, 1, -5, 10)).toBe(72); // B♭ → C
    expect(stepInKey(72, 1, -5, 10)).toBe(73); // C → D♭
    expect(stepInKey(70, -1, -5, 10)).toBe(68); // B♭ → A♭ (the key signature's)
    expect(pitchLabel(66, 2)).toBe('F♯4');
    expect(pitchLabel(70, -5, 10)).toBe('B♭4');
  });

  it('staff positions: G and F clefs, octave marks', () => {
    const top = 100;
    const gap = 10;
    expect(diatonicAtY(top, top, gap, 'G')).toBe(38); // F5 on the top line
    expect(diatonicAtY(top + 4 * gap, top, gap, 'G')).toBe(30); // E4 on the bottom line
    expect(diatonicAtY(top + 5 * gap, top, gap, 'G')).toBe(28); // C4 on the first ledger line
    expect(diatonicAtY(top, top, gap, 'F')).toBe(26); // A3
    expect(diatonicAtY(top + 4 * gap, top, gap, 'F')).toBe(18); // G2
    expect(diatonicAtY(top, top, gap, 'G', 8)).toBe(45); // 8va: F6
    expect(diatonicAtY(top + 4 * gap, top, gap, 'F', -8)).toBe(11); // 8vb: G1
    expect(diatonicToMidi(28, 0)).toBe(60);
    expect(diatonicToMidi(38, 1)).toBe(78);
    expect(yOfDiatonic(28, top, gap, 'G')).toBe(top + 5 * gap);
    expect(diatonic(spell(60, 0))).toBe(28);
  });

  it('a new note takes the accidental written earlier in the measure, else the key', () => {
    const song = plain([{ id: 1, midi: 66, start: 0, dur: q, hand: 'R' }]); // F♯4 in C
    const score = buildSheet(song, 'medium');
    const f4 = diatonic(spell(65, 0));
    expect(alterAt(score, 1, 0, 24, f4)).toBe(1);
    expect(alterAt(score, 1, 0, 0, f4)).toBe(0); // not before it
    expect(alterAt(score, 1, 1, 48, f4)).toBe(0); // next measure
    const d = plain([{ id: 1, midi: 62, start: 0, dur: q, hand: 'R' }], 'medium', { tonic: 2, mode: 'major' });
    expect(alterAt(buildSheet(d, 'medium'), 1, 0, 24, f4)).toBe(1); // D major: F♯
  });
});
