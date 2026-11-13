/*
 * SPDX-License-Identifier: AGPL-3.0-or-later AND Apache-2.0
 * Derived from `output_to_notes_polyphonic` (basic_pitch/note_creation.py) of
 * spotify/basic-pitch (https://github.com/spotify/basic-pitch), Copyright 2022 Spotify AB,
 * licensed under the Apache License, Version 2.0 (full text: public/models/basic-pitch/LICENSE).
 * Modified: rewritten in TypeScript by the Piano2Vision authors, with the changes noted below.
 */
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
  /** Re-join held notes chopped by other notes' attacks (RepeatJoinRule); omitted: REPEAT_JOIN, null: off. */
  joinRepeats?: RepeatJoinRule | null;
}

/**
 * Chopped held notes. An onset peak at a pitch that is still sounding ends the earlier event there
 * and starts a new one, so one held note can come out as back-to-back repeats of the same pitch.
 * On a piano most of these are real re-strikes (a repeated key under the pedal), but Basic Pitch's
 * onset head also fires on a held pitch when OTHER notes are struck (a chord change, a bass note
 * whose overtones land on the held pitch), and on sustained band instruments (bass, pads, strings,
 * synth leads) it fires weakly along the note. MAESTRO exact MIDI, back-to-back pairs whose second
 * note matches no reference onset ("piano" preset): 95 % start together with another note (real
 * re-strikes: 43 %) and their frame activation hardly rises again (median 0.08; re-strikes 0.22).
 *
 * The later event is joined into the earlier one when it starts at most `maxGapFrames` after the
 * earlier one ends (extraction makes them touch) and either
 *  - its onset belongs to another attack: its frame activation rise (peak over its first 5 frames
 *    minus the minimum over the 4 frames up to its start, as transcription/pipeline.ts frameRise)
 *    is below `maxRise`, and another pitch starts within `coFrames` frames with a model onset at
 *    least `coMargin` stronger than its own; or
 *  - there is no re-onset at all: its model onset is below `weakOnset` and its rise below
 *    `flatRise`. Only with inferred onsets (`inferOnsets`: "mix", "sensitive"), where a fluctuation
 *    of a sustained note's frame activation (vibrato, tremolo, bowing) starts events whose model
 *    onset is weak; "piano" starts events on model onset peaks only and gained nothing from it
 *    (and its Easy top line on MAESTRO Bach lost 0.017 chroma accuracy).
 * A re-strike whose activation rises again or whose onset stands on its own is kept, so the repeated
 * bass notes of the re-strike rule (music/cleanup.ts RESTRIKE, rise >= 0.15-0.25) stay apart.
 *
 * Tuned with tests/accuracy/sweep_extraction.mjs on MAESTRO exact MIDI (5 pieces, Liszt held out)
 * and the synthetic e2e pieces; onset F1@50 ms, mean of 5 / Liszt / e2e Bach:
 *   piano     0.8385 -> 0.8395 / 0.620 -> 0.620 / 0.937 -> 0.943 (no piece lower)
 *   sensitive 0.8237 -> 0.8405 / 0.694 -> 0.706 / 0.866 -> 0.898
 *   mix       0.7511 -> 0.7575 / 0.560 -> 0.564 / 0.842 -> 0.870
 * onset+offset F1 (pedal-extended reference) 0.3124 -> 0.3131 / 0.3256 -> 0.3307 / 0.2889 -> 0.2916;
 * C2-B2 recall unchanged. Same-pitch restarts within 40 ms of the previous note ("mix", Demucs
 * drum-less accompaniment of band-instrumental-1): 17.6 % -> 12.4 % of the notes; on the isolated bass
 * stem the joined bass pairs show no more attack than the middle of a note, the kept ones as much as a
 * fresh note. Larger `flatRise` values (0.08-0.1) remove more but start to join real re-plucks.
 */
export interface RepeatJoinRule {
  maxGapFrames: number;
  maxRise: number;
  coFrames: number;
  coMargin: number;
  weakOnset: number;
  flatRise: number;
}

export const REPEAT_JOIN: RepeatJoinRule = { maxGapFrames: 4, maxRise: 0.15, coFrames: 2, coMargin: 0.15, weakOnset: 0.75, flatRise: 0.05 };

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
  const join = opts.joinRepeats === undefined ? REPEAT_JOIN : opts.joinRepeats;
  if (!join) return notes;
  // the no-re-onset clause only where events also start on inferred (frame-difference) onsets
  return joinChoppedRepeats(notes, frames, n, opts.inferOnsets ? join : { ...join, weakOnset: 0 });
}

/** Frame-activation rise at `t0` for pitch index `f` (peak over t0..t0+4 minus the dip over t0-3..t0). */
function riseAt(frames: Float32Array, n: number, t0: number, f: number): number {
  let dip = Infinity;
  for (let t = t0 - 3; t <= t0; t++) dip = Math.min(dip, t >= 0 && t < n ? frames[t * P + f] : 0);
  let peak = 0;
  for (let t = Math.max(0, t0); t <= Math.min(n - 1, t0 + 4); t++) peak = Math.max(peak, frames[t * P + f]);
  return Math.max(0, peak - dip);
}

/**
 * Join back-to-back same-pitch events whose second onset is not a re-strike (RepeatJoinRule).
 * `notes` must be sorted by start frame; the result is too.
 */
export function joinChoppedRepeats(notes: RawNoteEvent[], frames: Float32Array, n: number, rule: RepeatJoinRule = REPEAT_JOIN): RawNoteEvent[] {
  if (notes.length < 2) return notes;
  const starts = notes.map((x) => x.startFrame);
  /** another pitch starts within ±coFrames of note i */
  const coStart = (i: number): boolean => {
    const t = starts[i];
    const need = notes[i].onset + rule.coMargin;
    const ok = (j: number) => notes[j].midi !== notes[i].midi && notes[j].onset >= need;
    for (let j = i - 1; j >= 0 && starts[j] >= t - rule.coFrames; j--) if (ok(j)) return true;
    for (let j = i + 1; j < notes.length && starts[j] <= t + rule.coFrames; j++) if (ok(j)) return true;
    return false;
  };
  const last = new Map<number, RawNoteEvent>();
  const dropped = new Set<number>();
  const out = notes.map((x) => ({ ...x }));
  for (let i = 0; i < out.length; i++) {
    const y = out[i];
    const x = last.get(y.midi);
    let join = false;
    if (x && y.startFrame - x.endFrame <= rule.maxGapFrames && y.startFrame >= x.startFrame) {
      const rise = riseAt(frames, n, y.startFrame, y.midi - BP_MIDI_OFFSET);
      join = (rise < rule.maxRise && coStart(i)) || (y.onset < rule.weakOnset && rise < rule.flatRise);
    }
    if (x && join) {
      const lx = x.endFrame - x.startFrame;
      const ly = y.endFrame - y.startFrame;
      if (y.endFrame > x.endFrame) {
        x.amplitude = (x.amplitude * lx + y.amplitude * ly) / Math.max(1, lx + ly);
        x.endFrame = y.endFrame;
      }
      dropped.add(i);
      continue;
    }
    last.set(y.midi, y);
  }
  return dropped.size ? out.filter((_, i) => !dropped.has(i)) : out;
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
