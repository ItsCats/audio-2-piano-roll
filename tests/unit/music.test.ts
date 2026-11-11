import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/lib/music/types';
import { estimateTempo, regularBeats, snapTime } from '../../src/lib/music/beats';
import { assignHands, clusterOnsets } from '../../src/lib/music/hands';
import { generateEasy, generateHard, generateMedium } from '../../src/lib/music/difficulty';
import { detectKey, formatLabel, noteName, parseNoteName } from '../../src/lib/music/theory';
import { exportMidi, parseMidi } from '../../src/lib/music/midi';
import { mergeContinuations, mergeFragments, suppressHarmonics } from '../../src/lib/music/cleanup';
import { bachPreludeDemo } from '../../src/lib/music/demo';
import { quantizeNotes } from '../../src/lib/music/quantize';

let id = 1;
const n = (midi: number, start: number, dur = 0.4, vel = 0.7, hand: Note['hand'] = 'R'): Note => ({ id: id++, midi, start, dur, vel, hand });

describe('theory', () => {
  it('names and parses notes', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61, { flats: true })).toBe('D♭4');
    expect(parseNoteName('F#3')).toBe(54);
    expect(parseNoteName('Bb2')).toBe(46);
    expect(formatLabel(62, 'solfege', 'sharps')).toBe('Re');
    expect(formatLabel(63, 'letter', 'flats')).toBe('E♭');
  });
  it('detects keys', () => {
    const cMajor = [60, 62, 64, 65, 67, 69, 71, 72].flatMap((m, i) => [n(m, i * 0.5), n(m - 12, i * 0.5 + 4)]);
    expect(detectKey(cMajor)?.name).toBe('C major');
    const aMinor = [57, 59, 60, 62, 64, 65, 68, 69, 57, 64, 69, 60].map((m, i) => n(m, i * 0.5, 0.5 + (m % 12 === 9 ? 1 : 0)));
    expect(detectKey(aMinor)?.name).toBe('A minor');
  });
});

describe('tempo & beats', () => {
  it('recovers a steady tempo from note onsets', () => {
    const notes: Note[] = [];
    const beat = 60 / 100;
    for (let i = 0; i < 64; i++) {
      notes.push(n(i % 4 === 0 ? 40 : 52, i * beat, beat * 0.9, i % 4 === 0 ? 0.9 : 0.5, 'L'));
      notes.push(n(72 + (i % 3), i * beat + beat / 2, beat / 2, 0.5));
    }
    const t = estimateTempo(notes, 64 * beat);
    expect(t.bpm).toBeGreaterThan(97);
    expect(t.bpm).toBeLessThan(103);
    expect(t.beatsPerBar).toBe(4);
  });
  it('recovers the Bach prelude tempo despite its 3-note figuration', () => {
    const d = bachPreludeDemo();
    const t = estimateTempo(d.notes, d.duration);
    expect(Math.abs(t.bpm - 66)).toBeLessThan(2);
  });
  it('snaps to the grid', () => {
    const beats = regularBeats(120, 0, 10);
    expect(snapTime(beats, 120, 0.26, 4)).toBeCloseTo(0.25, 6);
    expect(snapTime(beats, 120, 0.4, 2)).toBeCloseTo(0.5, 6);
  });
  it('quantizes with strength and window', () => {
    const tempo = { bpm: 120, beats: regularBeats(120, 0, 10), beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'manual' as const };
    const [a, b] = quantizeNotes([n(60, 0.27), n(62, 0.55)], tempo, { subdivision: 4, strength: 1, quantizeDurations: false });
    expect(a.start).toBeCloseTo(0.25);
    expect(b.start).toBeCloseTo(0.5);
    const [c] = quantizeNotes([n(60, 0.3)], tempo, { subdivision: 4, strength: 0.5, quantizeDurations: false });
    expect(c.start).toBeCloseTo(0.275);
  });
});

describe('hands', () => {
  it('splits bass and melody', () => {
    const notes = [n(36, 0), n(43, 0), n(72, 0), n(76, 0.5), n(38, 1), n(74, 1)];
    const out = assignHands(notes, 2);
    expect(out.filter((x) => x.midi < 50).every((x) => x.hand === 'L')).toBe(true);
    expect(out.filter((x) => x.midi > 70).every((x) => x.hand === 'R')).toBe(true);
  });
  it('never asks one hand to span more than ~an octave and a third in a chord', () => {
    const notes = [n(48, 0), n(55, 0), n(60, 0), n(64, 0), n(67, 0), n(72, 0)];
    for (const c of clusterOnsets(assignHands(notes, 1))) {
      for (const h of ['L', 'R'] as const) {
        const ps = c.filter((x) => x.hand === h).map((x) => x.midi);
        if (ps.length > 1) expect(Math.max(...ps) - Math.min(...ps)).toBeLessThanOrEqual(14);
      }
    }
  });
});

describe('difficulty levels', () => {
  const d = bachPreludeDemo();
  const easy = generateEasy(d.notes, d.tempo, d.duration);
  const medium = generateMedium(d.notes, d.tempo);
  const hard = generateHard(d.notes);
  it('keeps all notes on hard', () => expect(hard).toHaveLength(d.notes.length));
  it('orders levels by density', () => {
    expect(easy.length).toBeLessThan(medium.length);
    expect(medium.length).toBeLessThanOrEqual(hard.length);
  });
  it('easy right hand is a single melodic line', () => {
    const rh = easy.filter((x) => x.hand === 'R').sort((a, b) => a.start - b.start);
    for (let i = 1; i < rh.length; i++) expect(rh[i].start).toBeGreaterThanOrEqual(rh[i - 1].start + rh[i - 1].dur - 1e-6);
  });
  it('easy left hand stays in a comfortable register', () => {
    for (const x of easy.filter((x) => x.hand === 'L')) {
      expect(x.midi).toBeGreaterThanOrEqual(36);
      expect(x.midi).toBeLessThanOrEqual(57);
    }
  });
  it('easy melody avoids jumps over an octave', () => {
    const rh = easy.filter((x) => x.hand === 'R').sort((a, b) => a.start - b.start);
    const jumps = rh.slice(1).filter((x, i) => Math.abs(x.midi - rh[i].midi) > 12).length;
    expect(jumps / rh.length).toBeLessThan(0.05);
  });
  it('medium has at most three right-hand notes per onset', () => {
    for (const c of clusterOnsets(medium.filter((x) => x.hand === 'R'), 0.03)) expect(c.length).toBeLessThanOrEqual(3);
  });
  it('without a sung line a slow, unsure tempo keeps the 8th-note grid (no half-time refinement)', () => {
    const tempo = { bpm: 60, beats: regularBeats(60, 0, 20), beatsPerBar: 4, downbeatIndex: 0, confidence: 0.2, source: 'estimated' as const };
    const notes = [];
    for (let i = 0; i < 16; i++) notes.push(n(72 + (i % 5), i * 0.25, 0.24, 0.8), n(48, i * 0.25, 0.24, 0.7, 'L'));
    const rh = generateEasy(notes, tempo, 4).filter((x) => x.hand === 'R').sort((a, b) => a.start - b.start);
    expect(rh.length).toBeLessThanOrEqual(9); // one per 8th (0.5 s at 60 BPM), not one per 16th
    for (let i = 1; i < rh.length; i++) expect(rh[i].start - rh[i - 1].start).toBeGreaterThan(0.3);
  });
});

describe('cleanup', () => {
  it('merges tiny same-pitch gaps', () => {
    const out = mergeFragments([n(60, 0, 0.5), n(60, 0.51, 0.5)], 0.03);
    expect(out).toHaveLength(1);
    expect(out[0].dur).toBeCloseTo(1.01);
  });
  it('folds weak-onset continuations into ringing notes', () => {
    const a = n(60, 0, 0.5);
    const b = n(60, 0.6, 0.5);
    const strengths = new Map([[a.id, 0.9], [b.id, 0.3]]);
    expect(mergeContinuations([a, b], strengths, 0.7)).toHaveLength(1);
    strengths.set(b.id, 0.95);
    expect(mergeContinuations([a, b], strengths, 0.7)).toHaveLength(2);
  });
  it('removes quiet octave ghosts but keeps played octaves', () => {
    const base = n(48, 0, 1);
    const ghost = n(60, 0.01, 0.8);
    const amp = new Map([[base.id, 0.8], [ghost.id, 0.3]]);
    expect(suppressHarmonics([base, ghost], amp)).toHaveLength(1);
    amp.set(ghost.id, 0.7);
    expect(suppressHarmonics([base, ghost], amp)).toHaveLength(2);
  });
});

describe('MIDI', () => {
  it('round-trips notes, hands and pedal', () => {
    const d = bachPreludeDemo();
    const bytes = exportMidi(d.notes, d.pedal, d.tempo, 'Test');
    const parsed = parseMidi(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(parsed.notes).toHaveLength(d.notes.length);
    expect(parsed.pedal).toHaveLength(d.pedal.length);
    expect(parsed.tempo.bpm).toBeCloseTo(66, 0);
    const first = parsed.notes[0];
    expect(first.midi).toBe(60);
    expect(first.start).toBeCloseTo(0, 2);
    expect(parsed.notes.filter((x) => x.hand === 'L').length).toBe(d.notes.filter((x) => x.hand === 'L').length);
  });
});
