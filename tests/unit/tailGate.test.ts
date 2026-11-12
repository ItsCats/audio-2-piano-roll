import { describe, expect, it } from 'vitest';
import { TAIL_GATE, isTailGhost, onsetLevel, removeTailGhosts, tailStart } from '../../src/lib/music/cleanup';
import { clampToDuration, generateAllArrangements } from '../../src/lib/music/difficulty';
import { EXTRACTION_PRESETS, VOCAL_ADDBACK, VOCAL_EXTRACTION, addVocalsInto, cleanNotes, vocalsIntoAccomp } from '../../src/lib/transcription/pipeline';
import { timeToFrame } from '../../src/lib/transcription/constants';
import type { RawNoteEvent } from '../../src/lib/transcription/noteExtraction';
import type { Note, TempoInfo } from '../../src/lib/music/types';

let id = 1;
const note = (midi: number, start: number, dur: number, vel = 0.7, extra: Partial<Note> = {}): Note => ({ id: id++, midi, start, dur, vel, hand: 'R', ...extra });
const ev = (midi: number, startFrame: number, endFrame: number, amplitude = 0.8, onset = 0.9): RawNoteEvent => ({ midi, startFrame, endFrame, amplitude, onset });

describe('tail gate (ghost notes in near-silence)', () => {
  const ref = 0.3;
  const at = (db: number) => ref * 10 ** (db / 20);
  it('drops notes far below the song level anywhere, quiet or flat ones only in the tail', () => {
    const rms = new Float32Array(1000).fill(at(-55));
    expect(onsetLevel(rms, ref, 5).db).toBeCloseTo(-55, 1);
    // below the floor: a ghost wherever it is
    expect(isTailGhost(onsetLevel(rms, ref, 5), false)).toBe(true);
    // -45 dB: inaudible next to the song only in the tail; a soft section elsewhere keeps it
    const soft = new Float32Array(1000).fill(at(-45));
    expect(isTailGhost(onsetLevel(soft, ref, 5), false)).toBe(false);
    expect(isTailGhost(onsetLevel(soft, ref, 5), true)).toBe(true);
    // -32 dB and flat: a re-normalised tail, but only in the tail
    const flat = new Float32Array(1000).fill(at(-32));
    expect(isTailGhost(onsetLevel(flat, ref, 5), true)).toBe(true);
    expect(isTailGhost(onsetLevel(flat, ref, 5), false)).toBe(false);
    // -32 dB with the level rising at the onset: a real soft entry, even in the tail
    const rising = flat.slice();
    for (let i = 500; i < 510; i++) rising[i] *= 1.5;
    expect(isTailGhost(onsetLevel(rising, ref, 5), true)).toBe(false);
    // loud notes are never touched
    const loud = new Float32Array(1000).fill(ref * 0.8);
    expect(isTailGhost(onsetLevel(loud, ref, 5), true)).toBe(false);
  });

  it('the tail is the stretch after the last loud frame, at most 10 s long', () => {
    const rms = new Float32Array(1600);
    for (let i = 0; i < 1600; i++) rms[i] = i < 1000 ? ref : at(-30);
    expect(tailStart(rms, ref)).toBeCloseTo(9.99, 2);
    // a quiet ending longer than maxTailSec is a soft section, not a tail
    const long = new Float32Array(3000);
    for (let i = 0; i < 3000; i++) long[i] = i < 1000 ? ref : at(-30);
    expect(tailStart(long, ref)).toBe(Infinity);
    expect(tailStart(new Float32Array(100), ref)).toBe(Infinity);
    expect(TAIL_GATE.maxTailSec).toBe(10);
  });

  it('keeps quiet flat notes in a soft middle section (wide-dynamic recordings)', () => {
    // loud - a 20 s section 35 dB down (flat level: a pedalled pp texture) - loud again
    const rms = new Float32Array(6000);
    for (let i = 0; i < 6000; i++) rms[i] = i >= 2000 && i < 4000 ? at(-35) : ref;
    const notes = [{ start: 25 }, { start: 30 }, { start: 35 }];
    expect(removeTailGhosts(notes, rms, ref)).toHaveLength(3);
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
    // the vocal stem keeps its quiet notes (see VOCAL_EXTRACTION.tailGate)
    expect(VOCAL_EXTRACTION.tailGate).toBe(false);
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

describe('vocal stem added back without a sung line', () => {
  const B = VOCAL_ADDBACK.block;
  const tone = (n: number, amp: number, f = 0.05) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i * f));
  it('adds the stem where it carries a real share of the sound, not its residue', () => {
    const n = 40 * B;
    const accomp = tone(n, 0.5);
    const vocals = new Float32Array(n);
    // blocks 0-9: residue 45 dB down; blocks 25-39: a lead 3 dB down
    for (let i = 0; i < 10 * B; i++) vocals[i] = 0.5 * 10 ** (-45 / 20) * Math.sin(i * 0.031);
    for (let i = 25 * B; i < n; i++) vocals[i] = 0.5 * 10 ** (-3 / 20) * Math.sin(i * 0.031);
    const out = accomp.slice();
    addVocalsInto(out, vocals);
    // residue: untouched
    for (let i = 0; i < 10 * B; i++) expect(out[i]).toBe(accomp[i]);
    // the lead (well inside its stretch): summed in full
    for (let i = 30 * B; i < n; i += 97) expect(out[i]).toBeCloseTo(accomp[i] + vocals[i], 6);
    // a stem with no sound adds nothing; stems of different length: the common part
    const a = accomp.slice(0, 3 * B);
    addVocalsInto(a, new Float32Array(2 * B));
    expect(Array.from(a)).toEqual(Array.from(accomp.slice(0, 3 * B)));
  });

  it('goes back in when nobody sings, or when no melody line came out of the singing', () => {
    expect(vocalsIntoAccomp(false, 0)).toBe(true);
    expect(vocalsIntoAccomp(true, 0)).toBe(true);
    expect(vocalsIntoAccomp(true, 120)).toBe(false);
  });
});
