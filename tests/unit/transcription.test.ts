import { describe, expect, it } from 'vitest';
import { extractNotes, DEFAULT_EXTRACTION } from '../../src/lib/transcription/noteExtraction';
import { BP_FPS, BP_KEPT_FRAMES, frameToTime, timeToFrame } from '../../src/lib/transcription/constants';
import { EXTRACTION_PRESETS, VOCAL_EXTRACTION, cleanNotes, drumOnsetMax, frameRise, melodyFromRaw } from '../../src/lib/transcription/pipeline';
import { DRUM_HIT_RULE } from '../../src/lib/music/cleanup';
import type { RawNoteEvent } from '../../src/lib/transcription/noteExtraction';

const P = 88;
function posteriors(n: number) {
  return { frames: new Float32Array(n * P), onsets: new Float32Array(n * P) };
}
function addNote(p: ReturnType<typeof posteriors>, midi: number, start: number, len: number, amp = 0.8) {
  const f = midi - 21;
  p.onsets[start * P + f] = 0.9;
  for (let t = start; t < start + len; t++) p.frames[t * P + f] = amp;
}

describe('frame timing', () => {
  it('is monotonic and maps window boundaries exactly', () => {
    let prev = -1;
    for (let f = 0; f < 2000; f++) {
      const t = frameToTime(f);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    // first kept frame of window k sits at k * hop samples
    expect(frameToTime(BP_KEPT_FRAMES)).toBeCloseTo(36164 / 22050, 9);
  });
  it('drifts less than one frame per hour relative to the true sample clock', () => {
    const f = timeToFrame(3600);
    expect(Math.abs(frameToTime(f) - 3600)).toBeLessThan(1 / BP_FPS);
  });
});

describe('note extraction', () => {
  it('finds a sustained note with correct pitch and length', () => {
    const p = posteriors(300);
    addNote(p, 60, 20, 80);
    const notes = extractNotes(p.frames, p.onsets, 300, { ...DEFAULT_EXTRACTION, melodiaTrick: false });
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(60);
    expect(notes[0].startFrame).toBe(20);
    expect(notes[0].endFrame - notes[0].startFrame).toBeGreaterThanOrEqual(78);
  });
  it('separates repeated strikes of the same key', () => {
    const p = posteriors(400);
    addNote(p, 64, 20, 60);
    addNote(p, 64, 80, 60);
    const notes = extractNotes(p.frames, p.onsets, 400, { ...DEFAULT_EXTRACTION, melodiaTrick: false });
    expect(notes.map((n) => n.startFrame)).toEqual([20, 80]);
  });
  it('drops notes shorter than the minimum length', () => {
    const p = posteriors(200);
    addNote(p, 70, 10, 5);
    expect(extractNotes(p.frames, p.onsets, 200, { ...DEFAULT_EXTRACTION, minNoteFrames: 8 })).toHaveLength(0);
  });
  it('detects chords', () => {
    const p = posteriors(200);
    for (const m of [60, 64, 67]) addNote(p, m, 30, 50);
    const notes = extractNotes(p.frames, p.onsets, 200, { ...DEFAULT_EXTRACTION, melodiaTrick: false });
    expect(notes.map((n) => n.midi).sort()).toEqual([60, 64, 67]);
  });
  it('melodia trick recovers onset-less sustained pitch', () => {
    const p = posteriors(300);
    for (let t = 50; t < 150; t++) p.frames[t * P + 40] = 0.7; // no onset at all
    expect(extractNotes(p.frames, p.onsets, 300, { ...DEFAULT_EXTRACTION, melodiaTrick: false })).toHaveLength(0);
    expect(extractNotes(p.frames, p.onsets, 300, { ...DEFAULT_EXTRACTION, melodiaTrick: true })).toHaveLength(1);
  });
});

describe('vocal melody path', () => {
  const raw = (midi: number, startFrame: number, len: number, amplitude = 0.7) => ({ startFrame, endFrame: startFrame + len, midi, amplitude, onset: 0.8 });
  const rms = new Float32Array(3000).fill(0.2);

  it('turns vocal-stem note events into a single right-hand melody line', () => {
    const ev = [52, 54, 55, 57, 59, 57, 55, 54, 52, 50].flatMap((m, i) => [raw(m, 20 + i * 40, 36), raw(m + 12, 21 + i * 40, 20, 0.3)]);
    const line = melodyFromRaw(ev, rms, 20);
    expect(line.length).toBe(10);
    expect(line.every((n) => n.role === 'melody' && n.hand === 'R')).toBe(true);
    // a low (male) line is moved up into the right-hand register
    expect(line[0].midi).toBe(64);
    for (let i = 1; i < line.length; i++) expect(line[i].start).toBeGreaterThanOrEqual(line[i - 1].start + line[i - 1].dur - 1e-9);
  });

  it('a stem with only a few stray notes yields no melody', () => {
    expect(melodyFromRaw([raw(60, 10, 30), raw(62, 100, 30)], rms, 20)).toEqual([]);
  });

  it('the vocal parameters are not offered as a user preset', () => {
    expect(Object.keys(EXTRACTION_PRESETS)).not.toContain('vocal');
    expect(VOCAL_EXTRACTION.melodiaTrick).toBe(true);
  });
});

describe('re-strike rise (frame posteriors)', () => {
  const n = 400;
  /** 8-bit frames of one pitch: `levels` is a list of [fromFrame, value 0..1] steps */
  function track(midi: number, levels: [number, number][]) {
    const fr = new Uint8Array(n * P);
    for (let i = 0; i < levels.length; i++) {
      const [a, v] = levels[i];
      const b = i + 1 < levels.length ? levels[i + 1][0] : n;
      for (let t = a; t < b; t++) fr[t * P + midi - 21] = Math.round(v * 255);
    }
    return fr;
  }
  const ev = (midi: number, startFrame: number, endFrame: number, onset: number): RawNoteEvent => ({ startFrame, endFrame, midi, amplitude: 0.6, onset });
  const rms = new Float32Array(500).fill(0.1);
  const params = EXTRACTION_PRESETS.piano;

  it('frameRise is the peak after the start minus the dip before it', () => {
    const fr = track(40, [[0, 0], [10, 0.7], [60, 0.3], [64, 0.75], [120, 0]]);
    expect(frameRise(fr, n, 64, 40)).toBeCloseTo(0.45, 2);
    expect(frameRise(fr, n, 30, 40)).toBeCloseTo(0, 5);
    expect(frameRise(Float32Array.from(fr, (v) => v / 255), n, 64, 40)).toBeCloseTo(0.45, 2);
  });

  it('keeps a re-struck bass note apart, folds a ringing re-detection into the note before', () => {
    // same weak model onset (0.45) both times; only the struck one's frame activation rises again
    const struck = track(40, [[0, 0], [10, 0.7], [56, 0.35], [60, 0.75], [120, 0]]);
    const ringing = track(40, [[0, 0], [10, 0.7], [120, 0]]);
    const raw = [ev(40, 10, 60, 0.9), ev(40, 60, 120, 0.45)];
    expect(cleanNotes(raw, rms, params, 10, { frames: struck, nFrames: n })).toHaveLength(2);
    expect(cleanNotes(raw, rms, params, 10, { frames: ringing, nFrames: n })).toHaveLength(1);
    // without posteriors (older stored songs) the merge behaves as before
    expect(cleanNotes(raw, rms, params, 10)).toHaveLength(1);
  });
});

describe('drum-hit false low notes', () => {
  const rms = new Float32Array(3000).fill(0.1);
  const params = EXTRACTION_PRESETS.mix;
  const fps = 100;
  // frame index for a time in seconds (frameToTime is not uniform; search)
  const frameAt = (t: number) => timeToFrame(t);
  const ev = (midi: number, t: number, dur: number, onset = 0.55): RawNoteEvent => ({
    startFrame: frameAt(t),
    endFrame: frameAt(t + dur),
    midi,
    amplitude: 0.6,
    onset,
  });
  function drums(hits: number[], value = 60) {
    const d = new Uint8Array(20 * fps);
    for (const h of hits) d[Math.round(h * fps)] = value;
    return d;
  }
  // a sustained bass line on A1 (33) with E (40) under it, and a short C#2 (37) on a kick at 4.0 s
  const bassLine = [ev(33, 2, 1.8, 0.9), ev(33, 4.5, 1.5, 0.9), ev(40, 3.0, 0.9, 0.9)];

  it('drumOnsetMax reads the strongest hit in a window', () => {
    const d = drums([1, 1.5], 50);
    d[151] = 70;
    expect(drumOnsetMax(d, 0.98, 1.02)).toBe(50);
    expect(drumOnsetMax(d, 1.45, 1.6)).toBe(70);
    expect(drumOnsetMax(d, 1.1, 1.4)).toBe(0);
    expect(drumOnsetMax(d, 25, 30)).toBe(0);
  });

  it('drops a short, weakly-onset low note that starts on a drum hit off the bass line', () => {
    const raw = [...bassLine, ev(37, 4.0, 0.15)];
    const kept = cleanNotes(raw, rms, params, 20, { drums: drums([4.0], DRUM_HIT_RULE.minHit + 10) });
    expect(kept.map((x) => x.midi)).not.toContain(37);
    expect(kept.filter((x) => x.midi === 33)).toHaveLength(2);
    // no drum envelope (server stems, unseparated audio): nothing is dropped
    expect(cleanNotes(raw, rms, params, 20).map((x) => x.midi)).toContain(37);
    // a soft hit is not enough
    expect(cleanNotes(raw, rms, params, 20, { drums: drums([4.0], DRUM_HIT_RULE.minHit - 10) }).map((x) => x.midi)).toContain(37);
  });

  it('keeps bass notes on the beat: same pitch class as the bass line, long, or confidently onset', () => {
    const d = drums([4.0], 120);
    const cases: RawNoteEvent[] = [
      ev(45, 4.0, 0.15), // A2: the bass line's pitch class, an octave up
      ev(37, 4.0, 0.6), // rings on
      ev(37, 4.0, 0.15, 0.85), // confident onset
      ev(55, 4.0, 0.15), // above the drum register
    ];
    for (const c of cases) expect(cleanNotes([...bassLine, c], rms, params, 20, { drums: d }).some((x) => x.midi === c.midi && Math.abs(x.start - 4) < 0.02)).toBe(true);
  });
});
