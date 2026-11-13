import { describe, expect, it } from 'vitest';
import { LEAD_RECOVERY, capDensity, freshCandidates, overtoneCandidates, recoverLead, splitRestrikes } from '../../src/lib/music/leadRecovery';
import { mergeMelody } from '../../src/lib/music/melody';
import { generateAllArrangements, withoutHardOnly } from '../../src/lib/music/difficulty';
import { EXTRACTION_PRESETS, LEAD_PASS, accompFromRaw, heldEnd, leadPassParams, leadWorkerOptions, onsetPeak, sungRanges, withLeadPass } from '../../src/lib/transcription/pipeline';
import { BP_N_PITCHES, frameToTime, timeToFrame } from '../../src/lib/transcription/constants';
import type { RawNoteEvent } from '../../src/lib/transcription/noteExtraction';
import type { Note, TempoInfo } from '../../src/lib/music/types';

let id = 1;
const note = (midi: number, start: number, dur: number, vel = 0.7, extra: Partial<Note> = {}): Note => ({ id: id++, midi, start, dur, vel, hand: 'R', ...extra });
const ev = (midi: number, startFrame: number, endFrame: number, amplitude = 0.8, onset = 0.9): RawNoteEvent => ({ midi, startFrame, endFrame, amplitude, onset });

describe('lead recovery', () => {
  it('drops candidates the main notes already have, and glide neighbours', () => {
    const base = [note(72, 1, 1), note(76, 3, 0.5)];
    const cands = [
      note(72, 1.1, 0.5), // covered by the same pitch
      note(77, 3.01, 0.3), // a semitone from a main note starting together (glide)
      note(79, 5, 0.3), // new
      note(72, 0.6, 0.6), // runs into the main 72 at 1.0: cut there
      note(50, 6, 0.5), // below the lead register
    ];
    const fresh = freshCandidates(base, cands);
    expect(fresh.map((n) => n.midi).sort()).toEqual([72, 79]);
    const cut = fresh.find((n) => n.midi === 72)!;
    expect(cut.start + cut.dur).toBeLessThan(1);
  });

  it('caps the recovered notes per window, strongest first', () => {
    const rule = { ...LEAD_RECOVERY, maxPerSec: 1, capWindow: 2 };
    const ns = [note(70, 0, 0.1, 0.2), note(71, 0.5, 0.1, 0.9), note(72, 1, 0.1, 0.8), note(73, 1.5, 0.1, 0.3), note(74, 5, 0.1, 0.1)];
    const kept = capDensity(ns, (n) => n.vel, rule);
    expect(kept.map((n) => n.midi)).toEqual([71, 72, 74]);
  });

  it('keeps only candidates the tune line goes through, with posterior support', () => {
    // a tune 72-74-76-77-79 (one note missing from the main notes) over a low accompaniment
    const base = [note(48, 0, 4, 0.6), note(52, 0, 4, 0.6), note(72, 0, 0.4), note(74, 0.5, 0.4), note(77, 1.5, 0.4), note(79, 2, 0.4)];
    const missing = note(76, 1, 0.4, 0.6);
    const inner = note(64, 1, 0.4, 0.3); // an inner voice: not the tune
    const out = recoverLead(base, [missing, inner], 4);
    expect(out.some((n) => n.midi === 76 && Math.abs(n.start - 1) < 1e-9)).toBe(true);
    expect(out.some((n) => n.midi === 64)).toBe(false);
    // weak posterior evidence: not kept
    const weak = recoverLead(base, [missing], 4, { evidence: () => ({ mean: 0.1, spread: 0 }) });
    expect(weak).toBe(base);
    // inside a sung phrase: not kept
    expect(recoverLead(base, [missing], 4, { exclude: [[0.8, 1.6]] })).toBe(base);
    // Hard-only marking
    const marked = recoverLead(base, [missing], 4, { hardOnly: true });
    expect(marked.find((n) => n.midi === 76)?.role).toBe('lead');
  });

  it('Hard-only notes stay out of the hand split and out of Easy / Medium', () => {
    const acc = [note(40, 0, 1), note(43, 1, 1), note(64, 0, 1), note(67, 1, 1)];
    const lead = note(62, 0.5, 0.3, 0.7, { role: 'lead' });
    const merged = mergeMelody([...acc, lead], [], 2);
    const plain = mergeMelody(acc, [], 2);
    expect(merged.find((n) => n.role === 'lead')?.hand).toBe('R');
    expect(merged.filter((n) => n.role !== 'lead').map((n) => n.hand)).toEqual(plain.map((n) => n.hand));
    expect(withoutHardOnly(merged)).toHaveLength(4);
    const tempo: TempoInfo = { bpm: 120, beats: [0, 0.5, 1, 1.5, 2], beatsPerBar: 4, downbeatIndex: 0, confidence: 0.8, source: 'estimated' };
    const arr = generateAllArrangements(merged, [], tempo, 2);
    expect(arr.hard.notes.some((n) => n.role === 'lead')).toBe(true);
    expect(arr.easy.notes.some((n) => n.role === 'lead')).toBe(false);
    expect(arr.medium.notes.some((n) => n.role === 'lead')).toBe(false);
  });

  it('is part of the "Full song" preset only, read at run time, skipped when the main pass is as sensitive', () => {
    expect(EXTRACTION_PRESETS.mix.leadPass).toBe(true);
    expect(leadPassParams(EXTRACTION_PRESETS.mix)).toBe(LEAD_PASS);
    expect(leadWorkerOptions(EXTRACTION_PRESETS.piano)).toBeUndefined();
    expect(leadWorkerOptions(EXTRACTION_PRESETS.sensitive)).toBeUndefined();
    expect(leadWorkerOptions(EXTRACTION_PRESETS.mix)?.frameThreshold).toBe(LEAD_PASS.frameThreshold);
    // a slider edit keeps the flag; the pass follows LEAD_PASS, not a stored copy
    expect(leadPassParams({ ...EXTRACTION_PRESETS.mix, onsetThreshold: 0.4 })).toBe(LEAD_PASS);
    // main thresholds lowered to the pass's or below: the pass would add nothing
    expect(leadPassParams({ ...EXTRACTION_PRESETS.mix, frameThreshold: 0.25, minNoteMs: 50 })).toBeUndefined();
    expect(leadPassParams({ ...EXTRACTION_PRESETS.mix, frameThreshold: 0.25 })).toBe(LEAD_PASS);
  });

  it('songs imported with "Full song" before the flag existed re-detect like a new import', () => {
    const { leadPass: _f, ...legacy } = EXTRACTION_PRESETS.mix;
    void _f;
    expect(withLeadPass(legacy).leadPass).toBe(true);
    expect(withLeadPass({ ...legacy, frameThreshold: 0.4 }).leadPass).toBeUndefined(); // edited: left alone
    expect(withLeadPass(EXTRACTION_PRESETS.piano)).toBe(EXTRACTION_PRESETS.piano);
    expect(withLeadPass({ ...EXTRACTION_PRESETS.mix, leadPass: false }).leadPass).toBe(false);
  });

  it('accompFromRaw recovers a missing tune note as Hard-only and keeps the main notes for the tempo', () => {
    const rms = new Float32Array(500).fill(0.3);
    const raw = [ev(48, timeToFrame(0), timeToFrame(4)), ev(72, timeToFrame(0), timeToFrame(0.4)), ev(74, timeToFrame(0.5), timeToFrame(0.9)), ev(77, timeToFrame(1.5), timeToFrame(1.9))];
    const leadRaw = [...raw, ev(76, timeToFrame(1), timeToFrame(1.4))];
    const r = accompFromRaw(raw, leadRaw, rms, EXTRACTION_PRESETS.mix, 5);
    expect(r.main).toHaveLength(4);
    const added = r.notes.filter((x) => !r.main.includes(x));
    expect(added.map((n) => n.midi)).toEqual([76]);
    expect(added[0].role).toBe('lead');
    // inside a sung phrase nothing is recovered
    const sung = accompFromRaw(raw, leadRaw, rms, EXTRACTION_PRESETS.mix, 5, {}, { melody: [note(64, 0.9, 0.6, 0.7, { role: 'melody' })] });
    expect(sung.notes).toHaveLength(4);
    // no lead pass in the params, or no lead events: the main notes only
    expect(accompFromRaw(raw, leadRaw, rms, { ...EXTRACTION_PRESETS.mix, leadPass: false }, 5).notes).toHaveLength(4);
    expect(accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.mix, 5).notes).toHaveLength(4);
  });

  it('tests the evidence before choosing the line: a weak candidate on top does not hide the real one', () => {
    const base = [note(48, 0, 4, 0.6), note(52, 0, 4, 0.6), note(72, 0, 0.4), note(74, 0.5, 0.4), note(77, 1.5, 0.4), note(79, 2, 0.4)];
    const real = note(76, 1, 0.4, 0.6);
    const ghost = note(88, 1, 0.4, 0.6); // the faint octave above, on top: the line prefers it
    const evidence = (n: Note) => (n.midi === 88 ? { mean: 0.15, spread: 0, onset: 0.8 } : { mean: 0.4, spread: 0, onset: 0.8 });
    const out = recoverLead(base, [real, ghost], 4, { evidence });
    expect(out.some((n) => n.midi === 76)).toBe(true);
    expect(out.some((n) => n.midi === 88)).toBe(false);
  });

  it('asks for an onset; a clear onset lowers the activation needed', () => {
    const base = [note(48, 0, 4, 0.6), note(72, 0, 0.4), note(74, 0.5, 0.4), note(77, 1.5, 0.4), note(79, 2, 0.4)];
    const missing = note(76, 1, 0.4, 0.6);
    const keep = (e: { mean: number; spread: number; onset?: number }) => recoverLead(base, [missing], 4, { evidence: () => e }).some((n) => n.midi === 76);
    expect(keep({ mean: 0.4, spread: 0, onset: 0.3 })).toBe(false); // no attack: a held chord tone
    expect(keep({ mean: 0.4, spread: 0, onset: 0.5 })).toBe(true);
    expect(keep({ mean: 0.22, spread: 0, onset: 0.5 })).toBe(false);
    expect(keep({ mean: 0.22, spread: 0, onset: 0.7 })).toBe(true); // fast note with a clear attack
    expect(keep({ mean: 0.4, spread: 0 })).toBe(true); // no onset evidence: mean / spread only
  });

  it('finds overtones: an octave above a sounding, much stronger main note', () => {
    const low = note(64, 0, 1);
    const up = note(76, 0.3, 0.3);
    const fifth = note(71, 0.3, 0.3);
    const mean = (n: Note) => (n === low ? 0.6 : 0.3);
    expect([...overtoneCandidates([low], [up, fifth], 0.55, mean)]).toEqual([up]);
    expect(overtoneCandidates([low], [up], 0.55, (n) => (n === low ? 0.4 : 0.3)).size).toBe(0); // comparable strength: a doubled line
    expect(overtoneCandidates([note(64, 0, 0.2)], [up], 0.55, mean).size).toBe(0); // no longer sounding
  });

  it('splits a main note where a candidate re-strikes it', () => {
    const held = note(72, 0, 1);
    const again = note(72, 0.5, 0.3);
    const split = splitRestrikes([held], [again], LEAD_RECOVERY, () => ({ mean: 0.5, spread: 0, onset: 0.8, rise: 0.3 }));
    expect(split.map((n) => [n.start, +(n.start + n.dur).toFixed(3)])).toEqual([
      [0, 0.495],
      [0.5, 1],
    ]);
    expect(new Set(split.map((n) => n.id)).size).toBe(2);
    // flat activation (vibrato), a weak onset, or too soon after the start: one note
    expect(splitRestrikes([held], [again], LEAD_RECOVERY, () => ({ mean: 0.5, spread: 0, onset: 0.8, rise: 0.05 }))).toEqual([held]);
    expect(splitRestrikes([held], [again], LEAD_RECOVERY, () => ({ mean: 0.5, spread: 0, onset: 0.4, rise: 0.3 }))).toEqual([held]);
    expect(splitRestrikes([held], [note(72, 0.05, 0.3)], LEAD_RECOVERY, () => ({ mean: 0.5, spread: 0, onset: 0.8, rise: 0.3 }))).toEqual([held]);
    // inside a sung phrase: left alone
    expect(splitRestrikes([held], [again], LEAD_RECOVERY, () => ({ mean: 0.5, spread: 0, onset: 0.8, rise: 0.3 }), [[0.4, 0.6]])).toEqual([held]);
  });

  it('reads the onset peak and holds a note while its frame posterior stays above the off level', () => {
    const n = 300;
    const frames = new Float32Array(n * BP_N_PITCHES);
    const onsets = new Float32Array(n * BP_N_PITCHES);
    const f = 79 - 21;
    const t0 = timeToFrame(1);
    const t1 = timeToFrame(1.3);
    const t2 = timeToFrame(2);
    for (let t = t0; t < t1; t++) frames[t * BP_N_PITCHES + f] = 0.6;
    for (let t = t1; t < t2; t++) frames[t * BP_N_PITCHES + f] = 0.25; // under the detection threshold, above the off level
    onsets[t0 * BP_N_PITCHES + f] = 0.8;
    const g = note(79, frameToTime(t0), frameToTime(t1) - frameToTime(t0));
    expect(onsetPeak(onsets, n, g)).toBeCloseTo(0.8);
    expect(onsetPeak(onsets, n, note(79, 2.5, 0.2))).toBe(0);
    const end = heldEnd(frames, onsets, n, g, 3);
    expect(end).toBeGreaterThan(1.9);
    expect(end).toBeLessThan(2.05);
    expect(heldEnd(frames, onsets, n, g, 1.6)).toBeLessThanOrEqual(1.6); // capped
    // a new attack of the pitch ends the hold there
    const ra = timeToFrame(1.6);
    onsets[ra * BP_N_PITCHES + f] = 0.9;
    expect(heldEnd(frames, onsets, n, g, 3)).toBeCloseTo(frameToTime(ra), 5);
    // nothing to hold
    expect(heldEnd(frames, onsets, n, note(60, 1, 0.3), 3)).toBe(1.3);
  });

  it('sung phrases as merged time ranges', () => {
    expect(sungRanges([note(60, 0, 1), note(62, 1.5, 1), note(64, 5, 1)], 0.5)).toEqual([
      [-0.5, 3],
      [4.5, 6.5],
    ]);
  });
});
