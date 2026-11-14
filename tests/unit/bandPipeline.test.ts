import { describe, expect, it } from 'vitest';
import { BASS_BAND_PITCHES, BASS_LINE, bassBand, decodeBassLine, type BassPosteriors } from '../../src/lib/transcription/bassLine';
import { BP_FPS, BP_MIDI_OFFSET, BP_N_PITCHES, timeToFrame } from '../../src/lib/transcription/constants';
import { EXTRACTION_PRESETS, EXTRA_STEM_PASS_MAX_SECONDS, accompFromRaw, blendDetail, extraStemPasses, pianoBlendRuns, stemLevelDb, storedContext } from '../../src/lib/transcription/pipeline';
import { resampleTo } from '../../src/lib/transcription/decode';
import { packSpecNotes, type SpecNote } from '../../src/lib/music/pianoBlend';
import { mergeMelody } from '../../src/lib/music/melody';
import type { RawNoteEvent } from '../../src/lib/transcription/noteExtraction';
import type { StoredPosteriors } from '../../src/lib/transcription/posteriors';
import { storedPitch } from '../../src/lib/transcription/stemPitch';

const ev = (midi: number, startFrame: number, endFrame: number, amplitude = 0.8, onset = 0.9): RawNoteEvent => ({ midi, startFrame, endFrame, amplitude, onset });

/** Synthetic bass-stem posteriors (full 88-pitch rows): `events` = [midi, start s, end s, level]. */
function bassPost(seconds: number, events: [number, number, number, number][]): BassPosteriors & { frames: Float32Array; onsets: Float32Array } {
  const nFrames = Math.ceil(seconds * BP_FPS) + 1;
  const frames = new Float32Array(nFrames * BP_N_PITCHES);
  const onsets = new Float32Array(nFrames * BP_N_PITCHES);
  for (const [midi, a, b, level] of events) {
    const f = midi - BP_MIDI_OFFSET;
    for (let t = timeToFrame(a); t < timeToFrame(b); t++) frames[t * BP_N_PITCHES + f] = level;
    onsets[timeToFrame(a) * BP_N_PITCHES + f] = 0.9;
  }
  return { nFrames, frames, onsets };
}

describe('band pipeline (separated bass stem, stem passes)', () => {
  it('runs the extra stem passes only for the Full song preset, not on constrained devices or long recordings', () => {
    expect(extraStemPasses(EXTRACTION_PRESETS.mix, 200, false)).toBe(true);
    // a piano recording separated with the Piano / Sensitive preset keeps its left hand
    expect(extraStemPasses(EXTRACTION_PRESETS.piano, 200, false)).toBe(false);
    expect(extraStemPasses(EXTRACTION_PRESETS.sensitive, 200, false)).toBe(false);
    expect(extraStemPasses(EXTRACTION_PRESETS.mix, 200, true)).toBe(false);
    expect(extraStemPasses(EXTRACTION_PRESETS.mix, EXTRA_STEM_PASS_MAX_SECONDS + 1, false)).toBe(false);
  });

  it('measures a stem against the accompaniment: a near-silent bass stem is below the bass-line threshold', () => {
    const n = 22050 * 2;
    const ref = new Float32Array(n).map((_, i) => 0.5 * Math.sin(i / 7));
    const loud = ref.map((x) => x * 0.5);
    const quiet = ref.map((x) => x * 0.001);
    expect(stemLevelDb(loud, ref)).toBeCloseTo(-6, 0);
    expect(stemLevelDb(loud, ref)).toBeGreaterThanOrEqual(BASS_LINE.minLevelDb);
    expect(stemLevelDb(quiet, ref)).toBeLessThan(BASS_LINE.minLevelDb);
    expect(stemLevelDb(new Float32Array(n), ref)).toBe(-Infinity);
  });

  it('decodes the stored bass band exactly like the full posteriors', () => {
    const p = bassPost(4, [[40, 0.2, 1.2, 0.8], [43, 1.3, 2.2, 0.7], [36, 2.4, 3.5, 0.75]]);
    const band = { nFrames: p.nFrames, pitches: BASS_BAND_PITCHES, frames: bassBand(p.frames, p.nFrames), onsets: bassBand(p.onsets, p.nFrames) };
    expect(band.frames.length).toBe(p.nFrames * BASS_BAND_PITCHES);
    const strip = (ns: ReturnType<typeof decodeBassLine>) => ns.map((n) => [n.midi, n.start, n.dur, n.vel]);
    expect(strip(decodeBassLine(band))).toEqual(strip(decodeBassLine(p)));
    expect(decodeBassLine(band).map((n) => n.midi)).toEqual([40, 43, 36]);
  });

  it('merges the bass line only for the Full song preset, and tracks the beat on the notes from before the merge', () => {
    const rms = new Float32Array(500).fill(0.3);
    // the accompaniment pass: a bass E2 re-struck by the kick (two pieces) plus a chord above
    const raw = [ev(40, timeToFrame(0.2), timeToFrame(0.6)), ev(40, timeToFrame(0.65), timeToFrame(1.2)), ev(64, timeToFrame(0.2), timeToFrame(1.2)), ev(67, timeToFrame(0.2), timeToFrame(1.2))];
    const bass = bassPost(5, [[40, 0.2, 1.2, 0.85]]);
    const mix = accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.mix, 5, { bass });
    const low = mix.notes.filter((n) => n.midi < 48);
    expect(low).toHaveLength(1);
    expect(low[0].role).toBe('bass');
    // the beat is tracked on the notes before the bass-line swap
    expect(mix.main.filter((n) => n.midi < 48)).toHaveLength(2);
    expect(mix.main.some((n) => n.role === 'bass')).toBe(false);
    // Piano preset: the bass stem is not read as one line
    const piano = accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.piano, 5, { bass });
    const plain = accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.piano, 5);
    expect(piano.notes.map((n) => [n.midi, n.start, n.dur])).toEqual(plain.notes.map((n) => [n.midi, n.start, n.dur]));
    expect(piano.notes.some((n) => n.role === 'bass')).toBe(false);
  });

  it('gives re-detection the same evidence as the import: bass stem, stem pitch track, separated', () => {
    const n = 100;
    const leadPitch = storedPitch({ f0: new Float32Array(n), periodicity: new Float32Array(n), rms: new Float32Array(n), hop: 0.01 });
    const bass = { nFrames: 10, pitches: BASS_BAND_PITCHES, frames: new Uint8Array(10 * BASS_BAND_PITCHES), onsets: new Uint8Array(10 * BASS_BAND_PITCHES) };
    const post: StoredPosteriors = { nFrames: 10, frames: new Uint8Array(880), onsets: new Uint8Array(880), rms: new Float32Array(10), bass, leadPitch, separated: true };
    const ctx = storedContext(post);
    expect(ctx.bass).toBe(bass);
    expect(ctx.leadPitch).toBe(leadPitch);
    expect(ctx.separated).toBe(true);
    // an older record (none of these stored): re-detected as before
    const old = storedContext({ nFrames: 10, frames: new Uint8Array(880), onsets: new Uint8Array(880), rms: new Float32Array(10) });
    expect(old.bass).toBeUndefined();
    expect(old.leadPitch).toBeUndefined();
    expect(old.separated).toBe(false);
  });
});

describe('"Full song + piano model" blend (pipeline)', () => {
  const D = 6;
  const nFrames = Math.ceil(D * BP_FPS) + 1;
  /** accompaniment posteriors: `events` = [midi, start s, end s, frame level, onset level] */
  function post(events: [number, number, number, number, number][]) {
    const frames = new Float32Array(nFrames * BP_N_PITCHES);
    const onsets = new Float32Array(nFrames * BP_N_PITCHES);
    for (const [midi, a, b, level, on] of events) {
      const f = midi - BP_MIDI_OFFSET;
      for (let t = timeToFrame(a); t < timeToFrame(b); t++) frames[t * BP_N_PITCHES + f] = level;
      for (let t = timeToFrame(a); t <= timeToFrame(a) + 1; t++) onsets[t * BP_N_PITCHES + f] = on;
    }
    return { frames, onsets, nFrames };
  }
  // a tune C5 (0-1 s) and E5 (2.2-3.2 s) over a held C3; the piano model also hears an E4 under the
  // C5 (a fill), a D5 in the hole between them (a lead insert) and the tune notes themselves
  const tune: [number, number, number][] = [[72, 0.1, 1.0], [76, 2.2, 3.2], [48, 0.1, 3.2]];
  const raw = tune.map(([m, a, b]) => ev(m, timeToFrame(a), timeToFrame(b)));
  const rms = new Float32Array(D * 100).fill(0.3);
  const evidence = post([...tune.map(([m, a, b]) => [m, a, b, 0.8, 0.9] as [number, number, number, number, number]), [64, 0.3, 0.8, 0.3, 0.5], [74, 1.5, 1.9, 0.2, 0.5]]);
  const specialist: SpecNote[] = [
    { start: 0.1, dur: 0.9, midi: 72, vel: 0.8, onsetPeak: 0.95, frameMean: 0.8 },
    { start: 0.3, dur: 0.5, midi: 64, vel: 0.7, onsetPeak: 0.9, frameMean: 0.7 },
    { start: 1.5, dur: 0.4, midi: 74, vel: 0.8, onsetPeak: 0.9, frameMean: 0.7 },
    { start: 2.2, dur: 1.0, midi: 76, vel: 0.8, onsetPeak: 0.95, frameMean: 0.8 },
  ];
  const ctx = { ...evidence, separated: true };
  const strip = (ns: { midi: number; start: number; dur: number; role?: string; src?: string }[]) => ns.map((n) => [n.midi, +n.start.toFixed(4), +n.dur.toFixed(4), n.role ?? '', n.src ?? '']);

  it('adds the piano model’s notes (a fill under the tune, a lead note in its hole) and keeps every other note as it is', () => {
    const off = accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.mix, D, ctx);
    const on = accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.mix, D, { ...ctx, specialist });
    const added = on.notes.filter((n) => n.src === 'piano' || n.src === 'piano-lead');
    expect(added.map((n) => n.midi).sort()).toEqual([64, 74]);
    expect(strip(on.notes.filter((n) => !n.src))).toEqual(strip(off.notes));
    expect(on.blend).toEqual({ leadAdded: 1, fills: 1, riffSegments: 0, octaveFixes: 0 });
    expect(off.blend).toBeUndefined();
    // the beat is tracked on the same notes
    expect(strip(on.main)).toEqual(strip(off.main));
    // hands: the app's notes keep theirs
    const hands = (ns: { midi: number; start: number; hand: string; src?: string }[]) => ns.filter((n) => !n.src).map((n) => [n.midi, n.start, n.hand]);
    expect(hands(mergeMelody(on.notes, [], D))).toEqual(hands(mergeMelody(off.notes, [], D)));
  });

  it('does nothing for sung songs, unseparated songs or other presets, or without Basic Pitch posteriors', () => {
    const plain = (c: object, params = EXTRACTION_PRESETS.mix, lead = {}) => strip(accompFromRaw(raw, undefined, rms, params, D, c, lead).notes);
    const melody = [{ id: 9e6, midi: 79, start: 4, dur: 1, vel: 0.8, hand: 'R' as const, role: 'melody' as const }];
    expect(plain({ ...ctx, specialist }, EXTRACTION_PRESETS.mix, { melody })).toEqual(plain(ctx, EXTRACTION_PRESETS.mix, { melody }));
    expect(plain({ ...ctx, separated: false, specialist })).toEqual(plain({ ...ctx, separated: false }));
    expect(plain({ ...ctx, specialist }, EXTRACTION_PRESETS.piano)).toEqual(plain(ctx, EXTRACTION_PRESETS.piano));
    expect(plain({ separated: true, specialist })).toEqual(plain({ separated: true }));
  });

  it('re-detection gets the stored piano-model notes back (and older records none)', () => {
    const stored: StoredPosteriors = { nFrames: 10, frames: new Uint8Array(880), onsets: new Uint8Array(880), rms: new Float32Array(10), separated: true, specialist: packSpecNotes(specialist) };
    const back = storedContext(stored).specialist!;
    expect(back.map((n) => n.midi)).toEqual(specialist.map((n) => n.midi));
    back.forEach((n, i) => {
      expect(n.start).toBeCloseTo(specialist[i].start, 6);
      expect(n.onsetPeak).toBeCloseTo(specialist[i].onsetPeak, 6);
    });
    expect('specialist' in storedContext({ ...stored, specialist: undefined })).toBe(false);
  });

  it('runs only where the stem passes run, separated in the browser with a bass stem, without a sung line', () => {
    const ok = { separated: true, bassStem: true, sung: false };
    expect(pianoBlendRuns(EXTRACTION_PRESETS.mix, 200, false, ok)).toBe(true);
    expect(pianoBlendRuns(EXTRACTION_PRESETS.mix, 200, true, ok)).toBe(false);
    expect(pianoBlendRuns(EXTRACTION_PRESETS.mix, EXTRA_STEM_PASS_MAX_SECONDS + 1, false, ok)).toBe(false);
    expect(pianoBlendRuns(EXTRACTION_PRESETS.piano, 200, false, ok)).toBe(false);
    expect(pianoBlendRuns(EXTRACTION_PRESETS.mix, 200, false, { ...ok, bassStem: false })).toBe(false);
    expect(pianoBlendRuns(EXTRACTION_PRESETS.mix, 200, false, { ...ok, sung: true })).toBe(false);
    expect(pianoBlendRuns(EXTRACTION_PRESETS.mix, 200, false, { ...ok, separated: false })).toBe(false);
  });

  it('progress text', () => {
    expect(blendDetail({ stage: 'loading-model', loaded: 12e6, total: 41e6 })).toBe('Downloading the piano model (12 of 41 MB)');
    expect(blendDetail({ stage: 'loading-model' })).toBe('Preparing the piano model');
    expect(blendDetail({ stage: 'analyzing', done: 6, segments: 36 })).toBe('Analyzing segment 7 of 36');
  });
});

describe('resampleTo', () => {
  const tone = (hz: number, rate: number, seconds: number) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const rmsOf = (x: Float32Array, a: number, b: number) => Math.sqrt(x.subarray(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
  it('22.05 kHz to 16 kHz: same length in time, a 1 kHz tone keeps its level and phase', () => {
    const x = tone(1000, 22050, 1);
    const y = resampleTo(x, 22050, 16000);
    expect(y.length).toBe(16000);
    const ref = tone(1000, 16000, 1);
    expect(rmsOf(y, 1000, 15000)).toBeCloseTo(rmsOf(ref, 1000, 15000), 2);
    let err = 0;
    for (let i = 1000; i < 15000; i++) err = Math.max(err, Math.abs(y[i] - ref[i]));
    expect(err).toBeLessThan(0.01);
  });
  it('removes what is above the new Nyquist frequency (no aliasing)', () => {
    const y = resampleTo(tone(9500, 22050, 1), 22050, 16000);
    expect(rmsOf(y, 1000, 15000)).toBeLessThan(0.01);
  });
});
