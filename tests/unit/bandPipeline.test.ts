import { describe, expect, it } from 'vitest';
import { BASS_BAND_PITCHES, BASS_LINE, bassBand, decodeBassLine, type BassPosteriors } from '../../src/lib/transcription/bassLine';
import { BP_FPS, BP_MIDI_OFFSET, BP_N_PITCHES, timeToFrame } from '../../src/lib/transcription/constants';
import { EXTRACTION_PRESETS, EXTRA_STEM_PASS_MAX_SECONDS, accompFromRaw, extraStemPasses, stemLevelDb, storedContext } from '../../src/lib/transcription/pipeline';
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
