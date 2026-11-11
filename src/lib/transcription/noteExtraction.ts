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

/**
 * Register-dependent detection: the onset/frame thresholds and the minimum note length are
 * multiplied by factors that ramp linearly from 1 (at `lowMidi` / `highMidi`) to the given
 * value at the keyboard ends (MIDI 21 / 108). Basic Pitch's activations are much weaker for the
 * top and bottom octaves of a piano (short, quickly decaying or harmonically weak notes), so
 * thresholds that suit the middle of the keyboard miss most notes there. Omitted factors are 1.
 */
export interface RegisterCurve {
  lowMidi: number;
  highMidi: number;
  lowOnset?: number;
  lowFrame?: number;
  lowMinFrames?: number;
  highOnset?: number;
  highFrame?: number;
  highMinFrames?: number;
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
  /** Optional register-dependent scaling (none: the same thresholds for every pitch). */
  register?: RegisterCurve;
  /** Optional explicit per-pitch thresholds (88 values, MIDI 21..108); override threshold x register. */
  onsetThresholdByPitch?: ArrayLike<number>;
  frameThresholdByPitch?: ArrayLike<number>;
}

export interface PitchThresholds {
  // Float64 so that a threshold compares exactly like the scalar option did
  onset: Float64Array;
  frame: Float64Array;
  minFrames: Int32Array;
}

/** Scale factor of a register curve for one pitch (1 inside lowMidi..highMidi). */
function registerScale(midi: number, lowMidi: number, highMidi: number, low = 1, high = 1): number {
  const bottom = BP_MIDI_OFFSET;
  const top = BP_MIDI_OFFSET + P - 1;
  if (midi < lowMidi && low !== 1) return 1 + (low - 1) * Math.min(1, (lowMidi - midi) / Math.max(1, lowMidi - bottom));
  if (midi > highMidi && high !== 1) return 1 + (high - 1) * Math.min(1, (midi - highMidi) / Math.max(1, top - highMidi));
  return 1;
}

/** The effective onset/frame threshold and minimum note length (frames) of each of the 88 pitches. */
export function pitchThresholds(opts: NoteExtractionOptions): PitchThresholds {
  const onset = new Float64Array(P);
  const frame = new Float64Array(P);
  const minFrames = new Int32Array(P);
  const r = opts.register;
  for (let f = 0; f < P; f++) {
    const m = f + BP_MIDI_OFFSET;
    const so = r ? registerScale(m, r.lowMidi, r.highMidi, r.lowOnset, r.highOnset) : 1;
    const sf = r ? registerScale(m, r.lowMidi, r.highMidi, r.lowFrame, r.highFrame) : 1;
    const sm = r ? registerScale(m, r.lowMidi, r.highMidi, r.lowMinFrames, r.highMinFrames) : 1;
    onset[f] = opts.onsetThresholdByPitch?.[f] ?? opts.onsetThreshold * so;
    frame[f] = opts.frameThresholdByPitch?.[f] ?? opts.frameThreshold * sf;
    minFrames[f] = sm === 1 ? opts.minNoteFrames : Math.max(1, Math.round(opts.minNoteFrames * sm));
  }
  return { onset, frame, minFrames };
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
  const { onset: onsetThr, frame: frameThr, minFrames } = pitchThresholds(opts);
  const tol = opts.energyTolerance;

  // local maxima in time (order 1) above onset threshold, collected row-major (t, f).
  // A flat peak (equal neighbouring values — common on the 8-bit stored posteriors used for
  // re-detection) counts once, at its first frame; the reference's strict test would drop it.
  const starts: number[] = [];
  for (let t = 0; t < n; t++) {
    for (let f = 0; f < P; f++) {
      const v = onsets[t * P + f];
      if (v <= onsetThr[f]) continue;
      const prev = t > 0 ? onsets[(t - 1) * P + f] : -Infinity;
      if (!(v > prev)) continue;
      let j = t + 1;
      while (j < n && onsets[j * P + f] === v) j++;
      const next = j < n ? onsets[j * P + f] : -Infinity;
      if (v > next) starts.push(t * P + f);
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
    const thr = frameThr[f];
    let i = t0 + 1;
    let k = 0;
    while (i < n - 1 && k < tol) {
      if (remaining[i * P + f] < thr) k++;
      else k = 0;
      i++;
    }
    i -= k;
    if (i - t0 <= minFrames[f]) continue;
    for (let j = t0; j < i; j++) zeroAround(j, f);
    notes.push({ startFrame: t0, endFrame: i, midi: f + BP_MIDI_OFFSET, amplitude: meanAmp(t0, i, f), onset: onsetAt(t0, f) });
  }

  if (opts.melodiaTrick) {
    // candidates sorted by descending energy; cells are only ever zeroed, so iterating the
    // sorted list and skipping already-zeroed cells equals repeatedly taking the global max.
    const cand: number[] = [];
    for (let i = 0; i < remaining.length; i++) if (remaining[i] > frameThr[i % P]) cand.push(i);
    const vals = remaining;
    cand.sort((a, b) => vals[b] - vals[a]);
    for (const c of cand) {
      const tMid = Math.floor(c / P);
      const f = c - tMid * P;
      const thr = frameThr[f];
      if (remaining[c] <= thr) continue;
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
      if (iEnd - iStart <= minFrames[f]) continue;
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
