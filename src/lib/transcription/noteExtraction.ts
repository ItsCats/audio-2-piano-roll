/**
 * Polyphonic note extraction from Basic Pitch posteriorgrams.
 *
 * A faithful port of `output_to_notes_polyphonic` from spotify/basic-pitch, rewritten on
 * flat typed arrays. Differences from the reference JS port:
 *  - the "melodia trick" pass iterates candidates in pre-sorted order instead of
 *    re-scanning the whole matrix for the global max each iteration (identical result,
 *    since energy cells are only ever zeroed, but O(n log n) instead of O(n²)),
 *  - no array-of-arrays allocations, so it handles 10+ minute songs comfortably.
 */
import { BP_MIDI_OFFSET, BP_N_PITCHES } from './constants';

const P = BP_N_PITCHES;

export interface RawNoteEvent {
  startFrame: number;
  endFrame: number; // exclusive
  midi: number;
  amplitude: number;
  /** Peak model onset probability around the start (low for "melodia" continuation notes). */
  onset: number;
}

export interface NoteExtractionOptions {
  onsetThreshold: number;
  frameThreshold: number;
  minNoteFrames: number;
  inferOnsets: boolean;
  melodiaTrick: boolean;
  energyTolerance: number;
  minMidi: number;
  maxMidi: number;
}

export const DEFAULT_EXTRACTION: NoteExtractionOptions = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteFrames: 11,
  inferOnsets: true,
  melodiaTrick: true,
  energyTolerance: 11,
  minMidi: 21,
  maxMidi: 108,
};

/** Combine predicted onsets with positive frame-activation differences (onset inference). */
function inferredOnsets(frames: Float32Array, onsets: Float32Array, n: number): Float32Array {
  const nDiff = 2;
  const diff = new Float32Array(n * P);
  let diffMax = 0;
  let onsetMax = 0;
  for (let i = 0; i < onsets.length; i++) if (onsets[i] > onsetMax) onsetMax = onsets[i];
  for (let t = nDiff; t < n; t++) {
    for (let f = 0; f < P; f++) {
      const cur = frames[t * P + f];
      let m = Infinity;
      for (let d = 1; d <= nDiff; d++) {
        const prev = t - d >= 0 ? frames[(t - d) * P + f] : 0;
        const v = cur - prev;
        if (v < m) m = v;
      }
      if (m < 0) m = 0;
      diff[t * P + f] = m;
      if (m > diffMax) diffMax = m;
    }
  }
  const out = new Float32Array(n * P);
  const scale = diffMax > 0 ? onsetMax / diffMax : 0;
  for (let i = 0; i < out.length; i++) {
    const d = diff[i] * scale;
    out[i] = onsets[i] > d ? onsets[i] : d;
  }
  return out;
}

export function extractNotes(
  framesIn: Float32Array,
  onsetsIn: Float32Array,
  n: number,
  opts: NoteExtractionOptions = DEFAULT_EXTRACTION,
): RawNoteEvent[] {
  const frames = framesIn.slice(0, n * P);
  const onsetsCopy = onsetsIn.slice(0, n * P);
  // constrain frequency range
  const lo = Math.max(0, opts.minMidi - BP_MIDI_OFFSET);
  const hi = Math.min(P - 1, opts.maxMidi - BP_MIDI_OFFSET);
  if (lo > 0 || hi < P - 1) {
    for (let t = 0; t < n; t++) {
      for (let f = 0; f < P; f++) {
        if (f < lo || f > hi) {
          frames[t * P + f] = 0;
          onsetsCopy[t * P + f] = 0;
        }
      }
    }
  }
  const onsets = opts.inferOnsets ? inferredOnsets(frames, onsetsCopy, n) : onsetsCopy;
  const thr = opts.frameThreshold;
  const tol = opts.energyTolerance;

  // local maxima in time (order 1) above onset threshold, collected row-major (t, f)
  const starts: number[] = [];
  for (let t = 0; t < n; t++) {
    for (let f = 0; f < P; f++) {
      const v = onsets[t * P + f];
      if (v <= opts.onsetThreshold) continue;
      const prev = t > 0 ? onsets[(t - 1) * P + f] : -Infinity;
      const next = t < n - 1 ? onsets[(t + 1) * P + f] : -Infinity;
      if (v > prev && v > next) starts.push(t * P + f);
    }
  }

  const remaining = frames.slice();
  const notes: RawNoteEvent[] = [];
  const zeroAround = (t: number, f: number) => {
    remaining[t * P + f] = 0;
    if (f < P - 1) remaining[t * P + f + 1] = 0;
    if (f > 0) remaining[t * P + f - 1] = 0;
  };
  const onsetAt = (t: number, f: number) => {
    let m = 0;
    for (let j = Math.max(0, t - 1); j <= Math.min(n - 1, t + 1); j++) m = Math.max(m, onsetsCopy[j * P + f]);
    return m;
  };
  const meanAmp = (s: number, e: number, f: number) => {
    let sum = 0;
    for (let j = s; j < e; j++) sum += frames[j * P + f];
    return e > s ? sum / (e - s) : 0;
  };

  // process latest onsets first, as in the reference implementation
  for (let idx = starts.length - 1; idx >= 0; idx--) {
    const t0 = Math.floor(starts[idx] / P);
    const f = starts[idx] - t0 * P;
    if (t0 >= n - 1) continue;
    let i = t0 + 1;
    let k = 0;
    while (i < n - 1 && k < tol) {
      if (remaining[i * P + f] < thr) k++;
      else k = 0;
      i++;
    }
    i -= k;
    if (i - t0 <= opts.minNoteFrames) continue;
    for (let j = t0; j < i; j++) zeroAround(j, f);
    notes.push({ startFrame: t0, endFrame: i, midi: f + BP_MIDI_OFFSET, amplitude: meanAmp(t0, i, f), onset: onsetAt(t0, f) });
  }

  if (opts.melodiaTrick) {
    // candidates sorted by descending energy; cells are only ever zeroed, so iterating the
    // sorted list and skipping already-zeroed cells equals repeatedly taking the global max.
    const cand: number[] = [];
    for (let i = 0; i < remaining.length; i++) if (remaining[i] > thr) cand.push(i);
    const vals = remaining;
    cand.sort((a, b) => vals[b] - vals[a]);
    for (const c of cand) {
      if (remaining[c] <= thr) continue;
      const tMid = Math.floor(c / P);
      const f = c - tMid * P;
      remaining[c] = 0;
      let i = tMid + 1;
      let k = 0;
      while (i < n - 1 && k < tol) {
        if (remaining[i * P + f] < thr) k++;
        else k = 0;
        zeroAround(i, f);
        i++;
      }
      const iEnd = i - 1 - k;
      i = tMid - 1;
      k = 0;
      while (i > 0 && k < tol) {
        if (remaining[i * P + f] < thr) k++;
        else k = 0;
        zeroAround(i, f);
        i--;
      }
      const iStart = i + 1 + k;
      if (iEnd - iStart <= opts.minNoteFrames) continue;
      notes.push({
        startFrame: iStart,
        endFrame: iEnd,
        midi: f + BP_MIDI_OFFSET,
        amplitude: meanAmp(iStart, iEnd, f),
        onset: onsetAt(iStart, f),
      });
    }
  }
  notes.sort((a, b) => a.startFrame - b.startFrame || a.midi - b.midi);
  return notes;
}

/** Peak onset strength summed over pitch per frame — used for tempo/beat tracking. */
export function onsetEnvelope(frames: Float32Array, onsets: Float32Array, n: number): Float32Array {
  const env = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let f = 0; f < P; f++) {
      const o = onsets[t * P + f];
      const d = t > 0 ? Math.max(0, frames[t * P + f] - frames[(t - 1) * P + f]) : 0;
      s += o * o + 0.5 * d;
    }
    env[t] = s;
  }
  return env;
}
