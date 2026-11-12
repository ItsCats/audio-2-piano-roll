import { describe, expect, it } from 'vitest';
import { TAIL_GATE, isTailGhost, onsetLevel } from '../../src/lib/music/cleanup';
import { clampToDuration, generateAllArrangements } from '../../src/lib/music/difficulty';
import { EXTRACTION_PRESETS, addVocalsInto, cleanNotes } from '../../src/lib/transcription/pipeline';
import { timeToFrame } from '../../src/lib/transcription/constants';
import type { RawNoteEvent } from '../../src/lib/transcription/noteExtraction';
import type { Note, TempoInfo } from '../../src/lib/music/types';

let id = 1;
const note = (midi: number, start: number, dur: number, vel = 0.7, extra: Partial<Note> = {}): Note => ({ id: id++, midi, start, dur, vel, hand: 'R', ...extra });
const ev = (midi: number, startFrame: number, endFrame: number, amplitude = 0.8, onset = 0.9): RawNoteEvent => ({ midi, startFrame, endFrame, amplitude, onset });

describe('tail gate (ghost notes in near-silence)', () => {
  const ref = 0.3;
  it('flags notes far below the song level, and quiet notes without a level rise', () => {
    const rms = new Float32Array(1000).fill(ref * 10 ** (-50 / 20));
    expect(onsetLevel(rms, ref, 5).db).toBeCloseTo(-50, 1);
    expect(isTailGhost(onsetLevel(rms, ref, 5))).toBe(true);
    // -32 dB and flat: a re-normalised tail
    const flat = new Float32Array(1000).fill(ref * 10 ** (-32 / 20));
    expect(isTailGhost(onsetLevel(flat, ref, 5))).toBe(true);
    // -32 dB with the level rising at the onset: a real soft entry
    const rising = flat.slice();
    for (let i = 500; i < 510; i++) rising[i] *= 1.5;
    expect(isTailGhost(onsetLevel(rising, ref, 5))).toBe(false);
    // loud notes are never touched
    const loud = new Float32Array(1000).fill(ref * 0.8);
    expect(isTailGhost(onsetLevel(loud, ref, 5))).toBe(false);
  });

  it('cleanNotes drops a note in a decaying tail and keeps the music before it', () => {
    // 10 s of music at a steady level, then a cut at 10 s and an exponential decay to -80 dB
    const rms = new Float32Array(1600);
    for (let i = 0; i < 1600; i++) rms[i] = i < 1000 ? 0.3 : 0.3 * 10 ** ((-20 - (60 * (i - 1000)) / 600) / 20);
    const params = EXTRACTION_PRESETS.mix;
    const raw = [ev(60, timeToFrame(2), timeToFrame(2.5)), ev(72, timeToFrame(12.3), timeToFrame(12.8))];
    const kept = cleanNotes(raw, rms, params, 16);
    expect(kept.map((n) => n.midi)).toEqual([60]);
    // the gate can be turned off per preset
    expect(cleanNotes(raw, rms, { ...params, tailGate: false }, 16)).toHaveLength(2);
    // no level information at all: nothing is gated
    expect(cleanNotes(raw, new Float32Array(1600), params, 16)).toHaveLength(2);
    expect(TAIL_GATE.enabled).toBe(true);
  });

  it('cleanNotes and the arrangements end every note at the end of the audio', () => {
    const rms = new Float32Array(1000).fill(0.3);
    const kept = cleanNotes([ev(60, timeToFrame(8), timeToFrame(9.9))], rms, EXTRACTION_PRESETS.mix, 9);
    expect(kept[0].start + kept[0].dur).toBeLessThanOrEqual(9 + 1e-9);
    const c = clampToDuration([note(40, 1, 5), note(50, 9.5, 1)], 4);
    expect(c).toHaveLength(1);
    expect(c[0].dur).toBeCloseTo(3, 9);
    const tempo: TempoInfo = { bpm: 120, beats: Array.from({ length: 9 }, (_, i) => i * 0.5), beatsPerBar: 4, downbeatIndex: 0, confidence: 0.8, source: 'estimated' };
    const base = [note(45, 0, 1, 0.7, { hand: 'L' }), note(72, 0, 0.5), note(74, 0.5, 0.5), note(76, 1, 0.5), note(45, 3.5, 3, 0.7, { hand: 'L' }), note(77, 3.6, 2)];
    const arr = generateAllArrangements(base, [], tempo, 4);
    for (const lv of ['easy', 'medium', 'hard'] as const) for (const n of arr[lv].notes) expect(n.start + n.dur).toBeLessThanOrEqual(4 + 1e-9);
  });
});

describe('vocal stem added back without singing', () => {
  it('sums the stems in place over their common length', () => {
    const a = new Float32Array([0.1, 0.2, 0.3]);
    addVocalsInto(a, new Float32Array([0.5, 0.5]));
    expect(Array.from(a).map((x) => +x.toFixed(6))).toEqual([0.6, 0.7, 0.3]);
  });
});

