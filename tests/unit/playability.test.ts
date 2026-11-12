import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/lib/music/types';
import { enforcePlayability, LEVEL_OPTIONS, MAX_SPAN, playabilityPass, spanStats } from '../../src/lib/music/playability';

let id = 1;
const n = (midi: number, start: number, dur: number, hand: Note['hand'], vel = 0.7, role?: 'melody'): Note => ({
  id: id++,
  midi,
  start,
  dur,
  vel,
  hand,
  ...(role ? { role } : {}),
});

/** widest span one hand holds at any onset (everything sounding then) */
function widest(notes: Note[], hand: Note['hand']): number {
  return spanStats(notes, 0)[hand].maxSpan;
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** random two-hand texture on a 0.1 s onset grid with long held notes */
function randomTexture(seed: number, count = 160): Note[] {
  const r = rng(seed);
  const out: Note[] = [];
  for (let i = 0; i < count; i++) {
    const hand: Note['hand'] = r() < 0.5 ? 'L' : 'R';
    const midi = hand === 'L' ? 28 + Math.floor(r() * 36) : 55 + Math.floor(r() * 36);
    out.push(n(midi, Math.floor(r() * 120) * 0.1, 0.08 + r() * 2, hand, 0.2 + r() * 0.8));
  }
  return out;
}

describe('enforcePlayability', () => {
  it('uses a fifth / an octave / a ninth as the default reach', () => {
    expect(MAX_SPAN).toEqual({ easy: 7, medium: 12, hard: 14 });
  });

  it('moves a note out of an over-stretched hand to a free other hand (Hard keeps every note)', () => {
    // held bass C2 for 2 s, then a left-hand G3 (19 semitones above it); the right hand is silent
    const notes = [n(36, 0, 2, 'L'), n(55, 0.5, 0.4, 'L')];
    const out = enforcePlayability(notes, 'hard');
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.midi === 55)!.hand).toBe('R');
    expect(out.find((x) => x.midi === 36)!.hand).toBe('L');
    expect(out.map((x) => x.dur)).toEqual([2, 0.4]);
  });

  it('on Hard never drops or shortens: an unreachable stretch is left and counted', () => {
    // left hand C2 + G3 struck together, the right hand busy with a wide chord far above
    const notes = [n(36, 0, 1, 'L'), n(55, 0, 1, 'L'), n(72, 0, 1, 'R'), n(84, 0, 1, 'R')];
    const { notes: out, report } = playabilityPass(notes, LEVEL_OPTIONS.hard);
    expect(out).toHaveLength(4);
    expect(out.map((x) => [x.midi, x.hand, x.dur])).toEqual(notes.map((x) => [x.midi, x.hand, x.dur]));
    expect(report.unresolved).toBe(1);
    expect(report.dropped + report.trimmed).toBe(0);
  });

  it('on Medium drops the inner note, never the bass, when the other hand cannot take it', () => {
    const notes = [n(36, 0, 1, 'L'), n(43, 0, 1, 'L'), n(55, 0, 1, 'L', 0.4), n(72, 0, 1, 'R'), n(84, 0, 1, 'R')];
    const { notes: out, report } = playabilityPass(notes, LEVEL_OPTIONS.medium);
    expect(out.map((x) => x.midi)).toEqual([36, 43, 72, 84]);
    expect(report.dropped).toBe(1);
    expect(widest(out, 'L')).toBeLessThanOrEqual(12);
  });

  it('on Medium releases a held upper note at a new bass note instead of dropping anything', () => {
    // left hand C3 + G3, G3 held for 2 s; at 1 s a new bass E2 (15 below G3) under a busy right hand
    const notes = [n(48, 0, 0.5, 'L'), n(55, 0, 2, 'L'), n(40, 1, 0.5, 'L'), n(72, 1, 0.5, 'R'), n(84, 1, 0.5, 'R')];
    const out = enforcePlayability(notes, 'medium');
    expect(out).toHaveLength(5);
    const g3 = out.find((x) => x.midi === 55)!;
    expect(g3.start + g3.dur).toBeLessThanOrEqual(1);
    expect(widest(out, 'L')).toBeLessThanOrEqual(12);
    // Hard keeps it held (and counts the stretch)
    const { notes: hard, report } = playabilityPass(notes, LEVEL_OPTIONS.hard);
    expect(hard.find((x) => x.midi === 55)!.dur).toBe(2);
    expect(report.unresolved).toBe(1);
  });

  it('never drops, shortens or moves melody notes and never drops the lowest bass note', () => {
    // a held sung note C6 over a new right-hand chord tone C4 (two octaves below); the left hand
    // holds a wide bass + tenor pair under a busy texture
    const mel = n(84, 0, 2, 'R', 0.9, 'melody');
    const notes = [mel, n(60, 0.5, 0.5, 'R', 0.5), n(31, 0, 2, 'L'), n(50, 0.5, 0.5, 'L'), n(52, 0.5, 0.5, 'L')];
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const out = enforcePlayability(notes, level);
      const m = out.find((x) => x.role === 'melody')!;
      expect(m.hand).toBe('R');
      expect(m.dur).toBe(2);
      expect(out.some((x) => x.midi === 31 && x.hand === 'L')).toBe(true);
    }
  });

  it('on Medium shortens a held bass rather than dropping a new left-hand note above it', () => {
    // C2 held 2 s; at 1 s a left-hand D3 (14 above) while the right hand plays C5 (no room there)
    const notes = [n(36, 0, 2, 'L'), n(50, 1, 0.5, 'L'), n(72, 1, 0.5, 'R')];
    const { notes: out, report } = playabilityPass(notes, LEVEL_OPTIONS.medium);
    expect(report.dropped).toBe(0);
    expect(out.find((x) => x.midi === 50)!.hand).toBe('L');
    const c2 = out.find((x) => x.midi === 36)!;
    expect(c2.dur).toBeGreaterThan(0.9);
    expect(c2.start + c2.dur).toBeLessThanOrEqual(1);
    expect(widest(out, 'L')).toBeLessThanOrEqual(12);
    // a left-hand arpeggio over a held low note keeps every arpeggio note (right hand busy)
    const arp = [n(32, 0, 1.6, 'L'), n(39, 0.25, 0.3, 'L', 0.8), n(44, 0.5, 0.3, 'L', 0.8), n(48, 0.75, 0.3, 'L', 0.8), n(51, 1, 0.3, 'L', 0.8)];
    arp.push(n(74, 0, 1.6, 'R'), n(77, 0, 1.6, 'R'), n(81, 0, 1.6, 'R'));
    const kept = enforcePlayability(arp, 'medium');
    expect(kept).toHaveLength(arp.length);
    expect(widest(kept, 'L')).toBeLessThanOrEqual(12);
    expect(kept.find((x) => x.midi === 32)!.dur).toBeLessThanOrEqual(0.75);
    // but while most of a long bass is still to come, a quiet doubled new note goes instead
    const long = [n(36, 0, 4, 'L'), n(60, 0.5, 0.2, 'L', 0.3), n(72, 0.5, 0.5, 'R'), n(84, 0.5, 0.5, 'R')];
    const out2 = enforcePlayability(long, 'medium');
    expect(out2.find((x) => x.midi === 36)!.dur).toBe(4);
    expect(out2.some((x) => x.midi === 60)).toBe(false);
    // Hard still never shortens it
    expect(enforcePlayability(notes, 'hard').find((x) => x.midi === 36)!.dur).toBe(2);
  });

  it('puts melody notes in the right hand even if they arrive in the left', () => {
    const out = enforcePlayability([n(60, 0, 0.5, 'L', 0.8, 'melody'), n(40, 0, 0.5, 'L')], 'hard');
    expect(out.find((x) => x.role === 'melody')!.hand).toBe('R');
  });

  it('releases short legato overlaps on Medium but not on Hard', () => {
    // left hand C2 ends 60 ms after a new D3 starts
    const notes = [n(36, 0, 0.56, 'L'), n(62, 0.5, 0.5, 'L'), n(76, 0.5, 0.5, 'R'), n(88, 0.5, 0.5, 'R')];
    const med = enforcePlayability(notes, 'medium');
    expect(med).toHaveLength(4);
    expect(med.find((x) => x.midi === 36)!.dur).toBeLessThan(0.5);
    const hard = enforcePlayability(notes, 'hard');
    expect(hard.find((x) => x.midi === 36)!.dur).toBe(0.56);
  });

  it('moves only the note facing the other hand: the bass stays in the left hand', () => {
    // left C2 held + a new left F3 while the right hand holds C4: F3 goes to the right hand
    const notes = [n(36, 0, 2, 'L'), n(53, 0.5, 0.5, 'L'), n(60, 0, 2, 'R')];
    const out = enforcePlayability(notes, 'hard');
    expect(out.find((x) => x.midi === 36)!.hand).toBe('L');
    expect(out.find((x) => x.midi === 53)!.hand).toBe('R');
    // a new low bass under a held left-hand G4 with the right hand free: G4 moves up, the bass stays
    const low = enforcePlayability([n(67, 0, 2, 'L'), n(36, 0.5, 1, 'L')], 'hard');
    expect(low.find((x) => x.midi === 36)!.hand).toBe('L');
    expect(low.find((x) => x.midi === 67)!.hand).toBe('R');
  });

  it('does not put a moved note above the right hand\'s top note', () => {
    // left C2 held + a new left F3 while the right hand holds C3: F3 would become the right
    // hand's top voice, so it stays (Hard: counted)
    const { notes: out, report } = playabilityPass([n(36, 0, 2, 'L'), n(53, 0.5, 0.5, 'L'), n(48, 0, 2, 'R')], LEVEL_OPTIONS.hard);
    expect(out.find((x) => x.midi === 53)!.hand).toBe('L');
    expect(report.unresolved).toBe(1);
  });

  it('does not move a note under a higher note the other hand keeps', () => {
    // left C2 + G3 struck, G3 held 2 s; at 1 s the left hand adds B3: moving G3 into the (free)
    // right hand at 0 s would put it under the left hand's B3 at 1 s (crossing by 4), so it stays;
    // B3 itself can go up (one note per hand here)
    const notes = [n(36, 0, 2, 'L'), n(55, 0, 2, 'L'), n(59, 1, 0.5, 'L')];
    const { notes: out, report } = playabilityPass(notes, { ...LEVEL_OPTIONS.hard, maxStruck: 1, maxSounding: 1 });
    expect(out.find((x) => x.midi === 55)!.hand).toBe('L');
    expect(out.find((x) => x.midi === 59)!.hand).toBe('R');
    expect(report.unresolved).toBe(2);
  });

  it('never makes the hands cross (more than a whole tone) where they did not', () => {
    const cross = (notes: Note[], t: number) => {
      const at = (h: Note['hand']) => notes.filter((x) => x.hand === h && x.start <= t + 0.01 && x.start + x.dur > t + 0.02).map((x) => x.midi);
      const l = at('L');
      const r = at('R');
      return l.length && r.length ? Math.max(...l) - Math.min(...r) : -Infinity;
    };
    for (const seed of [11, 12, 13]) {
      const notes = randomTexture(seed);
      for (const level of ['medium', 'hard'] as const) {
        const out = enforcePlayability(notes, level);
        for (const t of new Set(out.map((x) => x.start))) expect(cross(out, t)).toBeLessThanOrEqual(Math.max(2, cross(notes, t)));
      }
    }
  });

  it('respects the finger count of the hand a note moves to', () => {
    const notes = [n(36, 0, 1, 'L'), n(55, 0, 1, 'L'), n(60, 0, 1, 'R'), n(62, 0, 1, 'R'), n(64, 0, 1, 'R')];
    // Medium: at most three right-hand notes struck together, so G3 is dropped instead
    const med = enforcePlayability(notes, 'medium');
    expect(med.filter((x) => x.hand === 'R' && x.start === 0).length).toBeLessThanOrEqual(3);
    expect(med.some((x) => x.midi === 36)).toBe(true);
    // Hard: up to five, so G3 moves
    expect(enforcePlayability(notes, 'hard').find((x) => x.midi === 55)!.hand).toBe('R');
  });

  it('accepts a custom reach', () => {
    const notes = [n(48, 0, 1, 'L'), n(58, 0, 1, 'L')];
    expect(enforcePlayability(notes, 'medium')).toHaveLength(2);
    const out = enforcePlayability(notes, 'medium', { maxSpan: 7 });
    expect(widest(out, 'L')).toBeLessThanOrEqual(7);
  });

  it('keeps Medium within an octave everywhere on random textures', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const notes = randomTexture(seed);
      const before = spanStats(notes, 12);
      const out = enforcePlayability(notes, 'medium');
      const after = spanStats(out, 12);
      expect(before.L.over + before.R.over).toBeGreaterThan(0);
      expect(after.L.over + after.R.over).toBe(0);
      // the lowest note of the piece is a bass note: never dropped
      const low = Math.min(...notes.map((x) => x.midi));
      expect(out.some((x) => x.midi === low)).toBe(true);
    }
  });

  it('keeps every Hard note unchanged except its hand and never makes spans worse', () => {
    for (const seed of [6, 7, 8]) {
      const notes = randomTexture(seed);
      const copy = JSON.parse(JSON.stringify(notes));
      const out = enforcePlayability(notes, 'hard');
      expect(notes).toEqual(copy); // input untouched
      const key = (x: Note) => `${x.id}:${x.midi}:${x.start}:${x.dur}:${x.vel}`;
      expect(out.map(key).sort()).toEqual(notes.map(key).sort());
      const b = spanStats(notes, 14);
      const a = spanStats(out, 14);
      expect(a.L.over + a.R.over).toBeLessThanOrEqual(b.L.over + b.R.over);
    }
  });

  it('is idempotent on Medium', () => {
    const once = enforcePlayability(randomTexture(9), 'medium');
    const { report } = playabilityPass(once, LEVEL_OPTIONS.medium);
    expect(report.overBefore).toBe(0);
  });
});
