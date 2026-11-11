import { describe, expect, it } from 'vitest';
import { extractNotes, DEFAULT_EXTRACTION } from '../../src/lib/transcription/noteExtraction';
import { BP_FPS, BP_KEPT_FRAMES, frameToTime, timeToFrame } from '../../src/lib/transcription/constants';

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
