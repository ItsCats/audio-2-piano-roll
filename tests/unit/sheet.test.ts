/** Sheet music: grid, quantization, voices, rhythm spelling, beams, pitch spelling, clefs, MusicXML. */
import { describe, expect, it } from 'vitest';
import type { Note, TempoInfo } from '../../src/lib/music/types';
import { buildGrid } from '../../src/lib/sheet/grid';
import { quantize, type RawNote } from '../../src/lib/sheet/quantize';
import { assignVoices, trimLegato, type VoiceContext } from '../../src/lib/sheet/voices';
import { beams, decompose, type RhythmContext } from '../../src/lib/sheet/rhythm';
import { AccidentalTracker, keyAlter, keyFifths, spell, spellChord } from '../../src/lib/sheet/spelling';
import { chooseClefs } from '../../src/lib/sheet/clefs';
import { buildScore } from '../../src/lib/sheet/score';
import { toMusicXml, xmlEscape } from '../../src/lib/sheet/musicxml';
import { systemBreaks } from '../../src/lib/sheet/layout';
import { DIV, LEVEL_RULES, type QNote } from '../../src/lib/sheet/types';
import { regularBeats } from '../../src/lib/music/beats';

const tempo = (bpm: number, over: Partial<TempoInfo> = {}): TempoInfo => ({
  bpm,
  beats: regularBeats(bpm, 0, 60),
  beatsPerBar: 4,
  downbeatIndex: 0,
  confidence: 1,
  source: 'midi',
  ...over,
});
let nid = 1;
const note = (midi: number, start: number, dur: number, hand: Note['hand'] = 'R'): Note => ({ id: nid++, midi, start, dur, vel: 0.7, hand });

/** Seeded random numbers (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per measure: summed durations of every voice (chord tones counted once), and backup durations. */
function voiceSums(xml: string): { number: string; sums: Map<string, number>; backups: number[] }[] {
  return [...xml.matchAll(/<measure number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)].map(([, number, body]) => {
    const sums = new Map<string, number>();
    const backups: number[] = [];
    for (const [tok] of body.matchAll(/<note>[\s\S]*?<\/note>|<forward>[\s\S]*?<\/forward>|<backup>[\s\S]*?<\/backup>/g)) {
      const dur = Number(/<duration>(\d+)<\/duration>/.exec(tok)![1]);
      if (tok.startsWith('<backup>')) {
        backups.push(dur);
        continue;
      }
      if (tok.includes('<chord/>')) continue;
      const v = /<voice>(\d+)<\/voice>/.exec(tok)![1];
      sums.set(v, (sums.get(v) ?? 0) + dur);
    }
    return { number, sums, backups };
  });
}

describe('sheet grid', () => {
  it('makes a pickup measure when the music starts before the first downbeat', () => {
    const t = buildGrid(tempo(120, { downbeatIndex: 1 }), 10, [{ start: 0 }]);
    expect(t.pickup).toBe(12);
    expect(t.measureStart(1)).toBe(12);
    expect(t.posToTime(t.measureStart(1))).toBeCloseTo(0.5, 6);
    expect(t.measureOf(11)).toBe(0);
    expect(t.measureOf(12)).toBe(1);
  });
  it('follows a MIDI tempo change', () => {
    const beats = [...Array.from({ length: 9 }, (_, i) => i * 0.5), ...Array.from({ length: 16 }, (_, i) => 4 + (i + 1) * 0.25)];
    const t = buildGrid(tempo(120, { beats }), 10, [{ start: 0 }]);
    expect(t.posToTime(t.measureStart(1))).toBeCloseTo(2, 6);
    expect(t.posToTime(t.measureStart(2))).toBeCloseTo(4, 6);
    expect(t.posToTime(t.measureStart(3))).toBeCloseTo(5, 6);
    expect(t.toPos(4.5)).toBeCloseTo(8 * DIV + 2 * DIV, 6);
  });
  it('falls back to a regular grid without beats', () => {
    for (const beats of [[], [0.3]]) {
      const t = buildGrid(tempo(120, { beats, source: 'estimated' }), 10, [{ start: 0 }]);
      expect(t.posToTime(t.measureStart(1)) - t.posToTime(t.measureStart(0))).toBeCloseTo(2, 6);
    }
  });
  it('drops leading empty bars', () => {
    const t = buildGrid(tempo(120), 20, [{ start: 4.0 }]);
    expect(t.posToTime(0)).toBeCloseTo(4, 6);
  });
  it('handles 3/4 and 6/8', () => {
    expect(buildGrid(tempo(120, { beatsPerBar: 3 }), 10, [{ start: 0 }]).measureLen).toBe(36);
    const t68 = buildGrid(tempo(180, { beatsPerBar: 6, beatUnit: 8 }), 10, [{ start: 0 }]);
    expect(t68.measureLen).toBe(36);
    expect(t68.compound).toBe(true);
    expect(t68.beatLen).toBe(18);
    // an old MIDI song without beatUnit: 6 beats per bar means 6/8
    expect(buildGrid(tempo(180, { beatsPerBar: 6 }), 10, [{ start: 0 }]).beatUnit).toBe(8);
  });
  it('halves an estimated tempo of 200 BPM', () => {
    const t = buildGrid(tempo(200, { source: 'estimated', confidence: 0.5 }), 30, [{ start: 0 }]);
    expect(t.bpm).toBeCloseTo(100, 0);
    expect(t.posToTime(t.measureStart(1))).toBeCloseTo(2.4, 2);
  });
});

const raw = (midi: number, onQ: number, offQ: number, staff: 1 | 2 = 1): RawNote => ({ midi, on: onQ * DIV, off: offQ * DIV, staff });

describe('sheet quantization', () => {
  it('puts Easy on 8ths', () => {
    const q = quantize([raw(60, 0.25, 0.5), raw(62, 0.75, 1.1), raw(64, 1.4, 2)], LEVEL_RULES.easy);
    for (const n of q.notes) {
      expect(n.on % 6).toBe(0);
      expect(n.off % 6).toBe(0);
      expect(n.off - n.on).toBeGreaterThanOrEqual(6);
    }
  });
  it('keeps ±30 ms jitter at 120 BPM on the grid', () => {
    const r = rng(7);
    const notes: RawNote[] = [];
    for (let i = 0; i < 64; i++) {
      const j = (r() * 2 - 1) * 0.06; // 30 ms = 0.06 quarters at 120 BPM
      notes.push(raw(60 + (i % 5), i * 0.5 + j, i * 0.5 + 0.45 + j));
    }
    const q = quantize(notes, LEVEL_RULES.medium);
    expect(q.notes.map((n) => n.on)).toEqual(notes.map((_, i) => i * 6));
    expect(q.tripletQuarters.size).toBe(0);
  });
  it('finds clean triplets on Medium and Hard; Easy plays them as straight 8ths', () => {
    const notes = Array.from({ length: 12 }, (_, i) => raw(60 + (i % 3), i / 3, i / 3 + 0.3));
    for (const level of ['medium', 'hard'] as const) {
      const q = quantize(notes, LEVEL_RULES[level]);
      expect([...q.tripletQuarters].sort()).toEqual([0, 1, 2, 3]);
      expect(q.notes.map((n) => n.on)).toEqual(notes.map((_, i) => i * 4));
    }
    const easy = quantize(notes, LEVEL_RULES.easy);
    expect(easy.tripletQuarters.size).toBe(0);
    // never a 16th-8th-16th rewrite of a triplet
    for (const n of easy.notes) expect(n.on % 6).toBe(0);
  });
  it('does not call jittered 16ths triplets', () => {
    const r = rng(3);
    const notes = Array.from({ length: 64 }, (_, i) => {
      const j = (r() * 2 - 1) * 0.06;
      return raw(60 + (i % 4), i / 4 + j, i / 4 + 0.2 + j);
    });
    expect(quantize(notes, LEVEL_RULES.hard).tripletQuarters.size).toBe(0);
    expect(quantize(notes, LEVEL_RULES.medium).tripletQuarters.size).toBe(0);
  });
  it('removes duplicates and cuts same-pitch overlaps', () => {
    const q = quantize([raw(60, 0, 1), raw(60, 0.02, 0.5), raw(60, 0.5, 1.5), raw(48, 0, 1, 2)], LEVEL_RULES.medium);
    expect(q.notes.filter((n) => n.midi === 60).map((n) => [n.on, n.off])).toEqual([
      [0, 6],
      [6, 18],
    ]);
  });
});

const vctx = (tripletQuarters = new Set<number>()): VoiceContext => ({ beatLen: 12, isBeat: (p) => p % 12 === 0, tripletQuarters });
const qn = (midi: number, on: number, off: number, staff: 1 | 2 = 1): QNote => ({ midi, on, off, staff });

describe('sheet voices', () => {
  it('writes a held bass under moving notes as two voices', () => {
    const notes = [qn(36, 0, 48, 2), ...[0, 6, 12, 18, 24, 30, 36, 42].map((p, i) => qn(48 + (i % 3) * 4, p, p + 6, 2))];
    for (const level of ['medium', 'hard'] as const) {
      const [v1, v2] = assignVoices(notes, 2, LEVEL_RULES[level], vctx());
      expect(v2).toEqual([expect.objectContaining({ on: 0, off: 48, midis: [36] })]);
      expect(v1).toHaveLength(8);
    }
    const [, easyV2] = assignVoices(notes, 2, LEVEL_RULES.easy, vctx());
    expect(easyV2).toHaveLength(0);
  });
  it('keeps a held chord under a higher note on Medium (right hand)', () => {
    // F4 + A♭4 held a bar, D5 a 16th later, then moving 8ths above
    const notes = [qn(65, 0, 48), qn(68, 0, 48), qn(74, 3, 12), ...[12, 18, 24, 30, 36, 42].map((p) => qn(72 + (p % 5), p, p + 6))];
    const [v1, v2] = assignVoices(notes, 1, LEVEL_RULES.medium, vctx());
    expect(v2).toEqual([expect.objectContaining({ on: 0, off: 48, midis: [65, 68] })]);
    expect(v1[0]).toEqual(expect.objectContaining({ on: 3, midis: [74] }));
  });
  it('a rolled chord keeps its bass held rather than writing it short', () => {
    // bass D3 held, F3 / (A♭3 + B3) rolled in after it, all held for a bar
    const notes = [qn(50, 0, 48, 2), qn(53, 3, 48, 2), qn(56, 6, 48, 2), qn(59, 6, 42, 2)];
    const [v1, v2] = assignVoices(notes, 2, LEVEL_RULES.hard, vctx());
    const bass = [...v1, ...v2].find((c) => c.midis.includes(50))!;
    expect(bass.off).toBe(48);
  });
  it('filling gaps never lets the voices cross', () => {
    const r = rng(5);
    for (let trial = 0; trial < 40; trial++) {
      const notes: QNote[] = [];
      for (let i = 0; i < 40; i++) {
        const on = Math.floor(r() * 64) * 3;
        notes.push(qn(40 + Math.floor(r() * 30), on, on + 3 * (1 + Math.floor(r() * 10)), 2));
      }
      const uniq = [...new Map(notes.map((n) => [`${n.midi}:${n.on}`, n])).values()];
      for (const level of ['medium', 'hard'] as const) {
        const [v1, v2] = assignVoices(uniq, 2, LEVEL_RULES[level], vctx());
        // a voice-1 chord that starts while a voice-2 chord sounds is never below it (and vice versa)
        for (const a of v1)
          for (const b of v2) {
            if (b.on < a.on && a.on < b.off) expect(a.midis[0], `trial ${trial}`).toBeGreaterThan(b.midis[b.midis.length - 1]);
            if (a.on < b.on && b.on < a.off) expect(b.midis[b.midis.length - 1], `trial ${trial}`).toBeLessThan(a.midis[0]);
          }
      }
    }
  });
  it('trims legato overlaps into one voice', () => {
    const notes = [qn(60, 0, 14), qn(62, 12, 26), qn(64, 24, 38), qn(65, 36, 48)];
    expect(trimLegato(notes, 12).map((n) => n.off)).toEqual([12, 24, 36, 48]);
    const [v1, v2] = assignVoices(notes, 1, LEVEL_RULES.hard, vctx());
    expect(v2).toHaveLength(0);
    expect(v1.map((c) => [c.on, c.off])).toEqual([
      [0, 12],
      [12, 24],
      [24, 36],
      [36, 48],
    ]);
  });
  it('never uses more than two voices and keeps every onset exactly once', () => {
    const r = rng(11);
    for (let trial = 0; trial < 20; trial++) {
      const notes: QNote[] = [];
      for (let i = 0; i < 60; i++) {
        const on = Math.floor(r() * 64) * 3;
        notes.push(qn(40 + Math.floor(r() * 40), on, on + 3 * (1 + Math.floor(r() * 12))));
      }
      const uniq = [...new Map(notes.map((n) => [`${n.midi}:${n.on}`, n])).values()];
      for (const level of ['easy', 'medium', 'hard'] as const) {
        const voices = assignVoices(uniq, 1, LEVEL_RULES[level], vctx());
        expect(voices).toHaveLength(2);
        const got: string[] = [];
        for (const v of voices) {
          for (let i = 0; i < v.length; i++) {
            expect(v[i].off).toBeGreaterThan(v[i].on);
            if (i) expect(v[i].on).toBeGreaterThanOrEqual(v[i - 1].off);
            for (const m of v[i].midis) got.push(`${m}:${v[i].on}`);
          }
        }
        expect(got.sort()).toEqual(uniq.map((n) => `${n.midi}:${n.on}`).sort());
      }
    }
  });
});

const rctx = (over: Partial<RhythmContext> = {}): RhythmContext => ({ measureStart: 0, measureLen: 48, beatLen: 12, compound: false, isTriplet: () => false, ...over });
const shape = (ps: ReturnType<typeof decompose>) => ps.map((p) => `${p.type}${p.dots ? '.' : ''}${p.triplet ? '3' : ''}`);

describe('sheet rhythm', () => {
  it.each([
    ['5 sixteenths from a beat', 0, 15, false, ['quarter', '16th']],
    ['an off-beat quarter', 6, 18, false, ['eighth', 'eighth']],
    ['a dotted quarter on the beat', 0, 18, false, ['quarter.']],
    ['a whole bar', 0, 48, false, ['whole']],
    ['three beats from beat 2', 12, 48, false, ['half', 'quarter']],
    ['a half rest on beat 2', 12, 36, true, ['quarter', 'quarter']],
    ['a dotted 8th from the beat', 0, 9, false, ['eighth.']],
    ['no dotted rests in 4/4', 0, 18, true, ['quarter', 'eighth']],
  ])('%s', (_, a, b, rest, want) => {
    expect(shape(decompose(a, b, rctx(), rest))).toEqual(want);
  });
  it('writes triplets inside triplet quarters', () => {
    const ctx = rctx({ isTriplet: (q) => q === 1 });
    expect(shape(decompose(12, 20, ctx))).toEqual(['quarter3']);
    expect(shape(decompose(16, 24, ctx))).toEqual(['quarter3']);
    expect(shape(decompose(6, 16, ctx))).toEqual(['eighth', 'eighth3']);
    expect(shape(decompose(12, 24, ctx))).toEqual(['quarter']);
  });
  it('groups compound meters in dotted quarters', () => {
    const ctx = rctx({ measureLen: 36, beatLen: 18, compound: true });
    expect(shape(decompose(0, 36, ctx))).toEqual(['half.']);
    expect(shape(decompose(6, 30, ctx))).toEqual(['quarter', 'quarter']);
    expect(shape(decompose(3, 18, ctx))).toEqual(['eighth.', 'eighth']);
  });
  it('never writes two dots, every voice fills its measure (seeded random songs)', () => {
    const r = rng(5);
    for (let trial = 0; trial < 12; trial++) {
      const level = (['easy', 'medium', 'hard'] as const)[trial % 3];
      const bpb = [4, 3, 2, 6][trial % 4];
      const notes: Note[] = [];
      let t = 0.1;
      for (let i = 0; i < 150; i++) {
        t += r() * 0.4;
        notes.push(note(30 + Math.floor(r() * 60), t, 0.05 + r() * 1.5, r() < 0.5 ? 'L' : 'R'));
        if (r() < 0.2) notes.push(note(30 + Math.floor(r() * 60), t + (r() - 0.5) * 0.02, 0.05 + r(), r() < 0.5 ? 'L' : 'R'));
      }
      const score = buildScore({ notes, tempo: tempo(100 + trial * 7, { beatsPerBar: bpb, beatUnit: bpb === 6 ? 8 : 4, downbeatIndex: trial % 2 }), duration: t + 2, level });
      const xml = toMusicXml(score, { title: 'x' });
      expect(xml).not.toMatch(/<dot\/><dot\/>/);
      voiceSums(xml).forEach(({ sums, backups }, m) => {
        const len = m === 0 && score.time.pickup ? score.time.pickup : score.time.measureLen;
        for (const s of sums.values()) expect(s).toBe(len);
        for (const b of backups) expect(b).toBe(len);
      });
    }
  });
});

describe('sheet beams', () => {
  const items = (spec: [number, number, string][]) => spec.map(([pos, dur, type]) => ({ pos, dur, type: type as never, triplet: false, rest: false }));
  it('beams each beat group', () => {
    const b = beams(items([[0, 3, '16th'], [3, 3, '16th'], [6, 3, '16th'], [9, 3, '16th'], [12, 6, 'eighth'], [18, 6, 'eighth']]), rctx());
    expect(b.map((x) => x.find((y) => y[0] === 1)?.[1])).toEqual(['begin', 'continue', 'continue', 'end', 'begin', 'end']);
    expect(b.slice(0, 4).map((x) => x.find((y) => y[0] === 2)?.[1])).toEqual(['begin', 'continue', 'continue', 'end']);
  });
  it('hooks a single 16th', () => {
    const b = beams(items([[0, 9, 'eighth'], [9, 3, '16th']]), rctx());
    expect(b).toEqual([[[1, 'begin']], [[1, 'end'], [2, 'backward hook']]]);
  });
  it('does not beam across a rest or a quarter', () => {
    const its = items([[0, 6, 'eighth'], [6, 6, 'eighth'], [12, 12, 'quarter'], [24, 6, 'eighth']]);
    its[1].rest = true;
    expect(beams(its, rctx()).every((x) => x.length === 0)).toBe(true);
  });
});

describe('sheet spelling', () => {
  const name = (midi: number, fifths: number, minor?: number) => {
    const s = spell(midi, fifths, minor);
    return s.step + (s.alter > 0 ? '♯'.repeat(s.alter) : '♭'.repeat(-s.alter)) + s.octave;
  };
  it('reads key signatures', () => {
    expect(keyFifths({ tonic: 0, mode: 'major' })).toBe(0);
    expect(keyFifths({ tonic: 7, mode: 'major' })).toBe(1);
    expect(keyFifths({ tonic: 5, mode: 'major' })).toBe(-1);
    expect(keyFifths({ tonic: 1, mode: 'major' })).toBe(-5);
    expect(keyFifths({ tonic: 6, mode: 'major' })).toBe(-6);
    expect(keyFifths({ tonic: 2, mode: 'minor' })).toBe(-1);
    expect(keyFifths({ tonic: 7, mode: 'minor' })).toBe(-2);
    expect(keyFifths(undefined)).toBe(0);
  });
  it('spells chromatic notes for the key', () => {
    expect([61, 63, 66, 68, 70].map((m) => name(m, 0))).toEqual(['C♯4', 'E♭4', 'F♯4', 'G♯4', 'B♭4']);
    expect([61, 66, 70].map((m) => name(m, -5))).toEqual(['D♭4', 'G♭4', 'B♭4']);
    expect([66, 61].map((m) => name(m, -6))).toEqual(['G♭4', 'D♭4']);
    expect(name(71, -6)).toBe('C♭5');
    expect(name(66, 1)).toBe('F♯4');
    expect(name(70, -1)).toBe('B♭4');
    expect(name(61, -1, 2)).toBe('C♯4'); // D minor leading tone
    expect(name(71, -1, 2)).toBe('B4'); // D minor raised 6th
    expect(name(66, -2, 7)).toBe('F♯4'); // G minor leading tone
  });
  it('never writes double accidentals, and E♯ / B♯ / F♭ / C♭ only when the key has them', () => {
    for (let tonic = 0; tonic < 12; tonic++)
      for (const mode of ['major', 'minor'] as const) {
        const f = keyFifths({ tonic, mode });
        for (let pc = 0; pc < 12; pc++) {
          const s = spell(60 + pc, f, mode === 'minor' ? tonic : undefined);
          expect(Math.abs(s.alter)).toBeLessThanOrEqual(1);
          const odd = (s.step === 'E' || s.step === 'B') && s.alter === 1 ? 1 : (s.step === 'F' || s.step === 'C') && s.alter === -1 ? -1 : 0;
          // allowed only when the key signature alters that letter, or as a minor key's leading tone / raised 6th
          if (odd && keyAlter(s.step, f) !== odd) expect(mode === 'minor' && (pc === (tonic + 11) % 12 || pc === (tonic + 9) % 12)).toBe(true);
        }
      }
    expect([69, 64, 71].map((m) => name(m, -5))).toEqual(['A4', 'E4', 'B4']); // D♭ major: not B𝄫, F♭, C♭
    expect([62, 69].map((m) => name(m, -6))).toEqual(['D4', 'A4']); // G♭ major: not E𝄫, B𝄫
    expect([67, 60].map((m) => name(m, 5))).toEqual(['G4', 'C4']); // B major: not F𝄪, B♯
    expect(name(65, 3)).toBe('F4'); // A major: not E♯
    expect(name(71, -3)).toBe('B4'); // E♭ major: not C♭
    expect([64, 71].map((m) => name(m, -4))).toEqual(['E4', 'B4']); // A♭ major: not F♭, C♭
  });
  it('never puts two notes of a chord on the same letter', () => {
    const nm = (s: { step: string; alter: number; octave: number }) => s.step + (s.alter > 0 ? '♯' : s.alter < 0 ? '♭' : '') + s.octave;
    expect(spellChord([62, 65, 69], 3).map(nm)).toEqual(['D4', 'F4', 'A4']); // A major iv chord
    expect(spellChord([65, 66], 0).map(nm)).toEqual(['F4', 'G♭4']);
    expect(spellChord([67, 68], 0).map(nm)).toEqual(['G4', 'A♭4']);
    expect(spellChord([62, 64, 65], -5).map(nm)).toEqual(['D4', 'E4', 'F4']);
    for (let f = -6; f <= 5; f++)
      for (let a = 60; a < 72; a++)
        for (let b = a + 1; b < 72; b++) {
          const [x, y] = spellChord([a, b], f);
          expect(x.step + x.octave === y.step + y.octave, `${a},${b} in ${f}`).toBe(false);
          expect(Math.abs(x.alter) <= 1 && Math.abs(y.alter) <= 1).toBe(true);
        }
  });
  it('tracks accidentals per bar; tie continuations print none', () => {
    const acc = new AccidentalTracker(0);
    const fs = spell(66, 0);
    const f = spell(65, 0);
    expect(acc.need(fs, false)).toBe('sharp');
    expect(acc.need(fs, false)).toBeNull();
    expect(acc.need(f, false)).toBe('natural');
    expect(acc.need(fs, true)).toBeNull();
    const score = buildScore({ notes: [note(66, 0, 0.4), note(66, 2, 0.4), note(66, 3.5, 1)], tempo: tempo(120), duration: 6, level: 'medium' });
    const xml = toMusicXml(score, { title: 't' });
    const measures = [...xml.matchAll(/<measure [\s\S]*?<\/measure>/g)].map((m) => m[0]);
    expect(measures[0]).toContain('<accidental>sharp</accidental>');
    expect(measures[1]).toContain('<accidental>sharp</accidental>');
    // the note tied from bar 2 into bar 3 shows no accidental there
    expect(measures[2]).toContain('<tie type="stop"/>');
    expect(measures[2]).not.toContain('<accidental>');
  });
});

describe('sheet clefs and octave marks', () => {
  it('marks a high run 8va and a low bass run 8vb', () => {
    const notes = [76, 84, 88, 91, 86].map((m, i) => note(m, i * 0.25, 0.25)).concat([28, 31, 33].map((m, i) => note(m, 2 + i * 0.5, 0.5, 'L')));
    const score = buildScore({ notes, tempo: tempo(120), duration: 4, level: 'hard' });
    expect(score.ottavas.map((o) => [o.staff, o.shift])).toEqual([
      [1, 8],
      [2, -8],
    ]);
    const xml = toMusicXml(score, { title: 't' });
    expect(xml).toContain('<octave-shift type="down" size="8"/>');
    expect(xml).toContain('<octave-shift type="up" size="8"/>');
    expect(xml.match(/<octave-shift type="stop"/g)).toHaveLength(2);
  });
  it('leaves single high notes alone', () => {
    const score = buildScore({ notes: [note(72, 0, 0.5), note(90, 0.5, 0.5), note(72, 1, 0.5)], tempo: tempo(120), duration: 2, level: 'hard' });
    expect(score.ottavas).toHaveLength(0);
  });
  it('does not flip-flop clefs on a wobbling melody, but changes for a long low passage', () => {
    const wobble = Array.from({ length: 12 }, (_, m) => (m % 2 ? [57, 59, 55, 57] : [64, 67, 65, 62]));
    expect(new Set(chooseClefs(wobble, 'G', true)).size).toBe(1);
    const low = [[64, 67], [65, 69], ...Array.from({ length: 4 }, () => [43, 45, 47, 41, 40, 43]), [64, 67], [65, 69]];
    expect(chooseClefs(low, 'G', true)).toEqual(['G', 'G', 'F', 'F', 'F', 'F', 'G', 'G']);
    expect(new Set(chooseClefs(low, 'G', false)).size).toBe(1);
  });
});

describe('sheet MusicXML', () => {
  const small = () =>
    buildScore({
      notes: [note(72, 0, 0.5), note(76, 0.5, 0.5), note(79, 1, 1), note(48, 0, 2, 'L'), note(55, 2, 1, 'L'), note(74, 2.25, 0.25), note(71, 3, 1)],
      tempo: tempo(120),
      key: { tonic: 0, mode: 'major' },
      duration: 4,
      level: 'medium',
    });
  it('writes the required elements in order', () => {
    const xml = toMusicXml(small(), { title: 'Song', artist: 'Band', credits: true, date: '2026-01-01' });
    const order = ['<!DOCTYPE score-partwise', '<score-partwise version="4.0">', '<work-title>Song</work-title>', '<identification>', '<creator type="composer">Band</creator>', '<rights>Transcribed with Piano2Vision</rights>', '<software>Piano2Vision</software>', '<credit page="1">', '<part-list>', '<part id="P1">', '<divisions>12</divisions>', '<key><fifths>0</fifths><mode>major</mode></key>', '<time><beats>4</beats><beat-type>4</beat-type></time>', '<staves>2</staves>', '<clef number="1"><sign>G</sign>', '<clef number="2"><sign>F</sign>', '<metronome', '<note>', '<bar-style>light-heavy</bar-style>'];
    let at = -1;
    for (const o of order) {
      const i = xml.indexOf(o, at + 1);
      expect(i, o).toBeGreaterThan(at);
      at = i;
    }
  });
  it('backs up by exactly one measure between voices', () => {
    for (const { backups } of voiceSums(toMusicXml(small(), { title: 't' }))) for (const b of backups) expect(b).toBe(48);
  });
  it('starts a range with complete attributes and the clefs in force', () => {
    const notes = Array.from({ length: 32 }, (_, i) => note(i >= 8 && i < 24 ? 45 : 67, i * 0.5, 0.5));
    const score = buildScore({ notes, tempo: tempo(120), key: { tonic: 7, mode: 'major' }, duration: 16, level: 'hard' });
    expect(score.clefs[0].slice(0, 8)).toEqual(['G', 'G', 'F', 'F', 'F', 'F', 'G', 'G']);
    const part = toMusicXml(score, { title: 't', from: 2, to: 4, breaks: [0, 2] });
    const first = /<measure number="3">([\s\S]*?)<\/measure>/.exec(part)![1];
    expect(first).toMatch(/^\s*<attributes>\n<divisions>12<\/divisions>\n<key><fifths>1<\/fifths>/);
    expect(first).toContain('<clef number="1"><sign>F</sign><line>4</line></clef>');
    expect(first).toContain('<clef number="2"><sign>F</sign>');
    expect(first).not.toContain('<print new-system');
    expect(part).not.toContain('<measure number="2"');
    expect(part).not.toContain('<metronome');
  });
  it('escapes titles', () => {
    expect(xmlEscape('A & B <C> "D"')).toBe('A &amp; B &lt;C&gt; &quot;D&quot;');
    expect(toMusicXml(small(), { title: 'Tom & "Jerry" <3>' })).toContain('<work-title>Tom &amp; &quot;Jerry&quot; &lt;3&gt;</work-title>');
  });
  it('breaks lines', () => {
    const score = small();
    expect(systemBreaks(score, 18)[0]).toBe(0);
  });
  it('matches the snapshot', () => {
    expect(toMusicXml(small(), { title: 'Snapshot', artist: 'Tester', credits: true, date: '2026-01-01' })).toMatchSnapshot();
  });
});
