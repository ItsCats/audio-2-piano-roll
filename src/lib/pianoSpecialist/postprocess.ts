/*! Piano2Vision piano-specialist note post-processing: a TypeScript port of RegressionPostProcessor from
 * piano_transcription_inference 0.0.6, Copyright (c) Qiuqiang Kong, MIT License. The full licence text ships
 * with the model: models/piano-specialist/LICENSE (Vite strips comments when it minifies, so that file is
 * the deployed notice) */
/**
 * Note events from the piano specialist's regression outputs: a faithful port of
 * RegressionPostProcessor (piano_transcription_inference 0.0.6, MIT, utilities.py + piano_vad.py;
 * Kong et al. 2021, "High-resolution Piano Transcription with Pedals by Regressing Onset and
 * Offset Times"). Pedal events are not ported (the in-browser model has no pedal head).
 *
 * Verified against the Python package on dumped model outputs of MAESTRO pieces: same notes,
 * onset/offset times within 1 ms (bit-identical in practice), same velocities
 * (tests/unit/postprocess.test.ts with PTI_DUMP_DIR set).
 *
 * Numeric details kept from the Python version (numpy 2 compares a float32 array element with a
 * Python float in float32, so the thresholds are rounded to float32 here too; `if bgn:` treats
 * frame 0 as "no onset", which cannot happen because peaks need `neighbour` frames on each side).
 */
import type { Note } from '../music/types';
import { newNoteId, sortNotes } from '../music/cleanup';

/** MIDI note of the model's first pitch (A0) and the number of pitches. */
export const PTI_BEGIN_NOTE = 21;
export const PTI_N_PITCHES = 88;

export interface RegressionOutputs {
  /** frame (note-on) probabilities, nFrames x 88, pitch-major per frame */
  frame: Float32Array;
  /** regressed onset, nFrames x 88 */
  onset: Float32Array;
  /** regressed offset, nFrames x 88 */
  offset: Float32Array;
  /** velocity 0..1, nFrames x 88 */
  velocity: Float32Array;
  nFrames: number;
  fps: number;
}

export interface RegressionOptions {
  onsetThreshold?: number;
  offsetThreshold?: number;
  frameThreshold?: number;
}

/** One detected note in the package's own terms (times in seconds, MIDI velocity 0..127/128). */
export interface RegressionNote {
  onset: number;
  offset: number;
  pitch: number;
  /** int(velocity * 128), as the package writes it to MIDI */
  velocity: number;
}

/** PianoTranscription defaults (inference.py). */
export const PTI_DEFAULTS: Required<RegressionOptions> = { onsetThreshold: 0.3, offsetThreshold: 0.3, frameThreshold: 0.1 };
/** frames after which a note without a detected offset is closed (piano_vad.py: 600 frames = 6 s) */
const MAX_NOTE_FRAMES = 600;
const VELOCITY_SCALE = 128;

/** Column k of a frame-major nFrames x 88 matrix. */
function column(m: Float32Array, nFrames: number, k: number): Float32Array {
  const out = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) out[t] = m[t * PTI_N_PITCHES + k];
  return out;
}

function isMonotonicNeighbour(x: Float32Array, n: number, neighbour: number): boolean {
  for (let i = 0; i < neighbour; i++) {
    if (x[n - i] < x[n - i - 1]) return false;
    if (x[n + i] < x[n + i + 1]) return false;
  }
  return true;
}

/**
 * get_binarized_output_from_regression for one pitch: local peaks above the threshold that rise
 * and fall monotonically over `neighbour` frames, with the sub-frame shift of the true peak
 * (Section III-D of the paper).
 */
export function binarize(x: Float32Array, threshold: number, neighbour: number): { binary: Uint8Array; shift: Float32Array } {
  const n0 = x.length;
  const binary = new Uint8Array(n0);
  const shift = new Float32Array(n0);
  const th = Math.fround(threshold);
  for (let n = neighbour; n < n0 - neighbour; n++) {
    if (x[n] > th && isMonotonicNeighbour(x, n, neighbour)) {
      binary[n] = 1;
      // float32 arithmetic, as numpy does on float32 scalars
      const a = Math.fround(x[n + 1] - x[n - 1]);
      const b = x[n - 1] > x[n + 1] ? Math.fround(x[n] - x[n + 1]) : Math.fround(x[n] - x[n - 1]);
      shift[n] = Math.fround(Math.fround(a / b) / 2);
    }
  }
  return { binary, shift };
}

/** note_detection_with_onset_offset_regress (piano_vad.py) for one pitch: [bgn, fin, onsetShift, offsetShift, velocity]. */
export function detectNotes(
  frame: Float32Array,
  onset: Uint8Array,
  onsetShift: Float32Array,
  offset: Uint8Array,
  offsetShift: Float32Array,
  velocity: Float32Array,
  frameThreshold: number,
): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  const th = Math.fround(frameThreshold);
  let bgn: number | null = null;
  let frameDisappear: number | null = null;
  let offsetOccur: number | null = null;
  const n0 = onset.length;
  for (let i = 0; i < n0; i++) {
    if (onset[i] === 1) {
      // consecutive onsets (e.g. the pedal is held and the key struck again): close the previous note
      if (bgn) {
        const fin = Math.max(i - 1, 0);
        out.push([bgn, fin, onsetShift[bgn], 0, velocity[bgn]]);
        frameDisappear = null;
        offsetOccur = null;
      }
      bgn = i;
    }
    if (bgn && i > bgn) {
      if (frame[i] <= th && !frameDisappear) frameDisappear = i;
      if (offset[i] === 1 && !offsetOccur) offsetOccur = i;
      if (frameDisappear) {
        const fin = offsetOccur && offsetOccur - bgn > frameDisappear - offsetOccur ? offsetOccur : frameDisappear;
        out.push([bgn, fin, onsetShift[bgn], offsetShift[fin], velocity[bgn]]);
        bgn = frameDisappear = offsetOccur = null;
      }
      if (bgn && (i - bgn >= MAX_NOTE_FRAMES || i === n0 - 1)) {
        const fin = i;
        out.push([bgn, fin, onsetShift[bgn], offsetShift[fin], velocity[bgn]]);
        bgn = frameDisappear = offsetOccur = null;
      }
    }
  }
  // (Python sorts by onset frame; the tuples are already in that order)
  return out;
}

/**
 * The package's note events, in its order (by pitch, then onset). Times are rounded to float32
 * as the package does (est_on_off_note_vels.astype(np.float32)).
 */
export function regressionToEvents(o: RegressionOutputs, opts: RegressionOptions = {}): RegressionNote[] {
  const { onsetThreshold, offsetThreshold, frameThreshold } = { ...PTI_DEFAULTS, ...opts };
  const { nFrames, fps } = o;
  const events: RegressionNote[] = [];
  for (let k = 0; k < PTI_N_PITCHES; k++) {
    const on = binarize(column(o.onset, nFrames, k), onsetThreshold, 2);
    const off = binarize(column(o.offset, nFrames, k), offsetThreshold, 4);
    const tuples = detectNotes(column(o.frame, nFrames, k), on.binary, on.shift, off.binary, off.shift, column(o.velocity, nFrames, k), frameThreshold);
    for (const [bgn, fin, onShift, offShift, vel] of tuples) {
      events.push({
        onset: Math.fround((bgn + onShift) / fps),
        offset: Math.fround((fin + offShift) / fps),
        pitch: k + PTI_BEGIN_NOTE,
        velocity: Math.trunc(Math.fround(vel) * VELOCITY_SCALE),
      });
    }
  }
  return events;
}

/**
 * The app's notes (velocity 0..1 on the MIDI scale, all in the right hand until hands are
 * assigned), sorted by start then pitch.
 */
export function regressionToNotes(o: RegressionOutputs, opts: RegressionOptions = {}): Note[] {
  const notes: Note[] = regressionToEvents(o, opts).map((e) => {
    const start = Math.max(0, e.onset);
    return {
      id: newNoteId(),
      midi: e.pitch,
      start,
      // a note shorter than 10 ms can only come from a sub-frame shift; keep it playable
      dur: Math.max(0.01, e.offset - start),
      vel: Math.max(1, Math.min(127, e.velocity)) / 127,
      hand: 'R' as const,
    };
  });
  return sortNotes(notes);
}
