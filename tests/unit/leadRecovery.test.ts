import { describe, expect, it } from 'vitest';
import { LEAD_RECOVERY, capDensity, freshCandidates, recoverLead } from '../../src/lib/music/leadRecovery';
import { mergeMelody } from '../../src/lib/music/melody';
import { generateAllArrangements, withoutHardOnly } from '../../src/lib/music/difficulty';
import { EXTRACTION_PRESETS, LEAD_PASS, accompFromRaw, leadWorkerOptions, sungRanges } from '../../src/lib/transcription/pipeline';
import { timeToFrame } from '../../src/lib/transcription/constants';
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

  it('is part of the "Full song" preset only, and accompFromRaw keeps the main notes for the tempo', () => {
    expect(EXTRACTION_PRESETS.mix.leadPass).toBe(LEAD_PASS);
    expect(leadWorkerOptions(EXTRACTION_PRESETS.piano)).toBeUndefined();
    expect(leadWorkerOptions(EXTRACTION_PRESETS.sensitive)).toBeUndefined();
    expect(leadWorkerOptions(EXTRACTION_PRESETS.mix)?.frameThreshold).toBe(LEAD_PASS.frameThreshold);
    const rms = new Float32Array(500).fill(0.3);
    const raw = [ev(48, timeToFrame(0), timeToFrame(4)), ev(72, timeToFrame(0), timeToFrame(0.4)), ev(74, timeToFrame(0.5), timeToFrame(0.9))];
    const leadRaw = [...raw, ev(76, timeToFrame(1), timeToFrame(1.4))];
    const r = accompFromRaw(raw, leadRaw, rms, EXTRACTION_PRESETS.mix, 5, {}, { hardOnly: true });
    expect(r.main).toHaveLength(3);
    expect(r.notes.length).toBeGreaterThanOrEqual(r.main.length);
    for (const n of r.notes.filter((x) => !r.main.includes(x))) expect(n.role).toBe('lead');
    expect(accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.mix, 5).notes).toHaveLength(3);
  });

  it('sung phrases as merged time ranges', () => {
    expect(sungRanges([note(60, 0, 1), note(62, 1.5, 1), note(64, 5, 1)], 0.5)).toEqual([
      [-0.5, 3],
      [4.5, 6.5],
    ]);
  });
});
