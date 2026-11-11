/**
 * Frame-wise f0 (Hz, 0 = unvoiced) + periodicity → note candidates for the melody line.
 *
 *   1. pitch in fractional MIDI, median-filtered within voiced runs (kills single-frame glitches);
 *   2. short unvoiced holes (< bridgeSec) between frames of about the same pitch are bridged;
 *   3. each voiced run is split where the pitch leaves the running segment median (the last
 *      ~300 ms of the segment) by more than splitSemitones and stays away for holdSec
 *      (vibrato swings around the median and does not split; a real step does);
 *   4. a segment's pitch is the rounded median of its frames;
 *   5. vibrato splits (A, short neighbour, A) and same-pitch neighbours are merged,
 *      segments shorter than minNoteSec are dropped (a glide into the next note is absorbed by it);
 *   6. salience (velocity) = mean periodicity of the segment's frames.
 */
import type { Note } from '../music/types';
import { newNoteId } from '../music/cleanup';
import { hzToMidi } from './crepe';

export interface SegmentOptions {
  /** median filter width over the pitch (frames, odd) */
  medianFrames: number;
  /** unvoiced gaps shorter than this inside a held pitch are bridged (seconds) */
  bridgeSec: number;
  /** a deviation from the running median larger than this (semitones)... */
  splitSemitones: number;
  /** ...held for at least this long starts a new note (seconds) */
  holdSec: number;
  /** running median length (seconds) */
  medianSec: number;
  /** shortest note kept (seconds) */
  minNoteSec: number;
  /** same-pitch neighbours closer than this are merged (seconds) */
  mergeGapSec: number;
  /** a neighbour-tone shorter than this between two equal pitches is vibrato (seconds) */
  vibratoSec: number;
}

export const DEFAULT_SEGMENT: SegmentOptions = {
  medianFrames: 5,
  bridgeSec: 0.04,
  splitSemitones: 0.7,
  holdSec: 0.05,
  medianSec: 0.3,
  minNoteSec: 0.06,
  mergeGapSec: 0.06,
  vibratoSec: 0.15,
};

interface Seg {
  a: number; // first frame
  b: number; // end frame (exclusive)
  midi: number;
  sal: number;
}

function median(v: number[]): number {
  const s = [...v].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/** Segment a pitch track into notes (see module comment). `hop` = seconds per frame. */
export function f0ToNotes(f0: Float32Array, periodicity: Float32Array, hop: number, opts: Partial<SegmentOptions> = {}): Note[] {
  const o = { ...DEFAULT_SEGMENT, ...opts };
  const n = f0.length;
  const midi = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (f0[i] > 0) midi[i] = hzToMidi(f0[i]);

  // 1. median filter within voiced runs
  const h = Math.floor(o.medianFrames / 2);
  const sm = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) continue;
    const w: number[] = [];
    for (let k = i - h; k <= i + h; k++) if (k >= 0 && k < n && !Number.isNaN(midi[k])) w.push(midi[k]);
    sm[i] = median(w);
  }

  // 2. bridge short holes between similar pitches
  const bridge = Math.max(0, Math.round(o.bridgeSec / hop));
  for (let i = 1; i < n; i++) {
    if (!Number.isNaN(sm[i]) || Number.isNaN(sm[i - 1])) continue;
    let j = i;
    while (j < n && Number.isNaN(sm[j])) j++;
    if (j < n && j - i <= bridge && Math.abs(sm[j] - sm[i - 1]) < 0.75) {
      for (let k = i; k < j; k++) sm[k] = sm[i - 1] + ((sm[j] - sm[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }

  // 3. split voiced runs at held pitch changes
  const hold = Math.max(1, Math.round(o.holdSec / hop));
  const medLen = Math.max(3, Math.round(o.medianSec / hop));
  const segs: Seg[] = [];
  const pushSeg = (a: number, b: number) => {
    if (b <= a) return;
    const v: number[] = [];
    let p = 0;
    for (let k = a; k < b; k++) {
      v.push(sm[k]);
      p += periodicity[k] || 0;
    }
    segs.push({ a, b, midi: Math.round(median(v)), sal: p / (b - a) });
  };
  let i = 0;
  while (i < n) {
    if (Number.isNaN(sm[i])) {
      i++;
      continue;
    }
    let start = i;
    let away = 0;
    let j = i + 1;
    for (; j < n && !Number.isNaN(sm[j]); j++) {
      const from = Math.max(start, j - away - medLen);
      const win: number[] = [];
      for (let k = from; k < j - away; k++) win.push(sm[k]);
      const ref = win.length ? median(win) : sm[start];
      if (Math.abs(sm[j] - ref) > o.splitSemitones) {
        away++;
        if (away >= hold) {
          const cut = j - away + 1;
          pushSeg(start, cut);
          start = cut;
          away = 0;
        }
      } else away = 0;
    }
    pushSeg(start, j);
    i = j;
  }

  // 5. merge same-pitch neighbours and vibrato splits; drop / absorb short segments
  const gapF = o.mergeGapSec / hop;
  const vibF = o.vibratoSec / hop;
  const len = (s: Seg) => s.b - s.a;
  const absorb = (into: Seg, s: Seg) => {
    const la = len(into);
    const lb = len(s);
    into.sal = (into.sal * la + s.sal * lb) / Math.max(1, la + lb);
    into.b = Math.max(into.b, s.b);
  };
  let cur = segs;
  for (let pass = 0; pass < 2; pass++) {
    const out: Seg[] = [];
    for (let k = 0; k < cur.length; k++) {
      const s = { ...cur[k] };
      const prev = out[out.length - 1];
      const nx = cur[k + 1];
      if (prev && nx && len(s) < vibF && nx.midi === prev.midi && Math.abs(s.midi - prev.midi) <= 2 && s.a - prev.b <= gapF && nx.a - s.b <= gapF) {
        absorb(prev, s);
        absorb(prev, nx);
        k++;
        continue;
      }
      if (prev && prev.midi === s.midi && s.a - prev.b <= gapF) {
        absorb(prev, s);
        continue;
      }
      out.push(s);
    }
    cur = out;
  }
  const minF = o.minNoteSec / hop;
  const kept: Seg[] = [];
  for (let k = 0; k < cur.length; k++) {
    const s = cur[k];
    if (len(s) >= minF) {
      kept.push(s);
      continue;
    }
    // a short scoop glued to the next note becomes its start
    const nx = cur[k + 1];
    if (nx && nx.a - s.b <= 1 && Math.abs(nx.midi - s.midi) <= 3 && len(nx) >= minF) nx.a = s.a;
  }

  return kept.map((s) => ({
    id: newNoteId(),
    midi: Math.max(21, Math.min(108, s.midi)),
    start: s.a * hop,
    dur: (s.b - s.a) * hop,
    vel: Math.max(0.15, Math.min(1, s.sal)),
    hand: 'R' as const,
    role: 'melody' as const,
  }));
}
