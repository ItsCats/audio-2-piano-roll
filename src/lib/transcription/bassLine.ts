/**
 * The separated BASS stem read as ONE bass line (a bass guitar plays one note at a time).
 *
 * Why: the accompaniment pass runs Basic Pitch, a many-notes-at-once detector, on bass + other
 * summed. On a bass it re-strikes held notes, doubles them an octave up and turns kick-drum thumps
 * that leak into the bass stem into short low notes: the "extra low left-hand notes" of band
 * songs (band-instrumental-1, review: 60 re-strikes, 58 octave duplicates and 36 drum leaks of 186
 * flagged left-hand notes; 635 of the 654 left-hand notes below C3 came from the bass stem).
 *
 * How: Basic Pitch runs on the bass stem alone (its own pass). decodeBassLine() then finds the best
 * single path through the frame posteriors between `minMidi` and `maxMidi` plus a "silent" state
 * (Viterbi: a pitch state earns its frame activation, silence earns `silence`; changing pitch,
 * starting and stopping cost), so at most one bass note sounds at a time. A note starts where the
 * path changes pitch or, inside a run of one pitch, where the onset posterior shows a clear new
 * attack (a repeated bass note). Notes shorter than `minMs` or without a clear pitch (mean
 * activation under `minMean`: a kick has no steady pitch) are dropped, and so are notes with both a
 * soft attack and a wavering pitch (`weakOnset` / `weakMean`: on 8 dumped Slakh tracks this removed
 * 40 bass-line notes that matched no bass note for 6 correct ones).
 *
 * pipeline.ts accompFromRaw then takes the low notes of the accompaniment pass that the bass stem
 * explains out (bassExplained) and puts this line in instead; chord notes from the other
 * instruments stay. With a (nearly) silent bass stem, or without separation, nothing changes.
 */
import type { Note } from '../music/types';
import { newNoteId, sortNotes } from '../music/cleanup';
import { BP_FPS, BP_MIDI_OFFSET, BP_N_PITCHES, frameToTime, timeToFrame } from './constants';

export interface BassLineRule {
  /** pitch range of the line (E1..G3) */
  minMidi: number;
  maxMidi: number;
  /** frame reward of the silent state: a pitch must be heard above this to be on the path */
  silence: number;
  /** path cost of moving to another pitch / of starting a note after silence */
  switchCost: number;
  onCost: number;
  /** onset posterior (local peak) that starts a new note inside a run of one pitch */
  restrike: number;
  /** ...at least this long (s) after the current note's start */
  restrikeAfter: number;
  /** shortest kept note (ms) */
  minMs: number;
  /** a kept note's mean frame activation (the clear-pitch test) */
  minMean: number;
  /** the bass stem's level (dB re the accompaniment, 95th percentile frame RMS) below which it is treated as silent */
  minLevelDb: number;
  /**
   * a note's start moves back to the strongest onset of its pitch up to `snapBack` s earlier when
   * that onset reaches `snapOnset` (the path enters a pitch a little after its attack); 0: off
   */
  snapBack: number;
  snapOnset: number;
  /**
   * a note without a clear attack (onset posterior at its start under `weakOnset`) is kept only with
   * a clearly held pitch (mean activation at least `weakMean`): kick thumps and other instruments
   * bleeding into the bass stem have soft attacks and a wavering pitch; 0: off
   */
  weakOnset: number;
  weakMean: number;
}

export const BASS_LINE: BassLineRule = {
  minMidi: 28,
  maxMidi: 55,
  silence: 0.3,
  switchCost: 0.6,
  onCost: 0.4,
  restrike: 0.6,
  restrikeAfter: 0.1,
  minMs: 70,
  minMean: 0.35,
  minLevelDb: -30,
  snapBack: 0.1,
  snapOnset: 0.3,
  weakOnset: 0.4,
  weakMean: 0.6,
};

/** Posteriors of the bass stem's own Basic Pitch pass (8-bit stored or float, nFrames x 88). */
export interface BassPosteriors {
  nFrames: number;
  frames: Uint8Array | Float32Array;
  onsets: Uint8Array | Float32Array;
}

const scaleOf = (a: Uint8Array | Float32Array) => (a instanceof Uint8Array ? 1 / 255 : 1);

/** The bass stem's one-note-at-a-time line (see the module comment). Notes are hand 'L'. */
export function decodeBassLine(post: BassPosteriors, rule: Partial<BassLineRule> = {}): Note[] {
  const r = { ...BASS_LINE, ...rule };
  const { nFrames, frames, onsets } = post;
  const P = BP_N_PITCHES;
  const lo = Math.max(0, r.minMidi - BP_MIDI_OFFSET);
  const hi = Math.min(P - 1, r.maxMidi - BP_MIDI_OFFSET);
  const K = hi - lo + 1;
  if (nFrames < 2 || K < 1) return [];
  const fs = scaleOf(frames);
  const os = scaleOf(onsets);
  const S = K + 1; // state K = silent
  const back = new Uint8Array(nFrames * S);
  let score = new Float64Array(S);
  let next = new Float64Array(S);
  for (let k = 0; k < K; k++) score[k] = frames[lo + k] * fs - r.onCost;
  score[K] = r.silence;
  for (let t = 1; t < nFrames; t++) {
    // best pitch state of the previous frame (for a pitch change)
    let bestK = 0;
    for (let k = 1; k < K; k++) if (score[k] > score[bestK]) bestK = k;
    let secondK = bestK === 0 ? (K > 1 ? 1 : 0) : 0;
    for (let k = 0; k < K; k++) if (k !== bestK && score[k] > score[secondK]) secondK = k;
    const row = t * P;
    for (let k = 0; k < K; k++) {
      let b = score[k];
      let from = k;
      const other = k === bestK ? secondK : bestK;
      if (other !== k && score[other] - r.switchCost > b) {
        b = score[other] - r.switchCost;
        from = other;
      }
      if (score[K] - r.onCost > b) {
        b = score[K] - r.onCost;
        from = K;
      }
      next[k] = b + frames[row + lo + k] * fs;
      back[t * S + k] = from;
    }
    // silence: stay, or stop the best note
    let b = score[K];
    let from = K;
    if (score[bestK] > b) {
      b = score[bestK];
      from = bestK;
    }
    next[K] = b + r.silence;
    back[t * S + K] = from;
    [score, next] = [next, score];
  }
  // backtrack
  const path = new Uint8Array(nFrames);
  let s = 0;
  for (let k = 1; k < S; k++) if (score[k] > score[s]) s = k;
  for (let t = nFrames - 1; t >= 0; t--) {
    path[t] = s;
    if (t > 0) s = back[t * S + s];
  }
  // runs of one pitch, split at clear re-attacks
  const segs: { k: number; a: number; b: number }[] = [];
  const minRestrikeFrames = Math.max(1, timeToFrame(r.restrikeAfter));
  let t = 0;
  while (t < nFrames) {
    const k = path[t];
    let e = t;
    while (e + 1 < nFrames && path[e + 1] === k) e++;
    if (k !== K) {
      let a = t;
      const col = lo + k;
      for (let u = t + minRestrikeFrames; u <= e; u++) {
        if (u - a < minRestrikeFrames) continue;
        const o = onsets[u * P + col] * os;
        if (o >= r.restrike && o >= onsets[(u - 1) * P + col] * os && (u + 1 >= nFrames || o >= onsets[(u + 1) * P + col] * os)) {
          segs.push({ k, a, b: u - 1 });
          a = u;
        }
      }
      segs.push({ k, a, b: e });
    }
    t = e + 1;
  }
  // the path enters a pitch late when the previous note still rings: back to its attack
  if (r.snapBack > 0) {
    const back = Math.max(1, Math.round(r.snapBack * BP_FPS));
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      const col = lo + g.k;
      const floor = i > 0 ? segs[i - 1].a + 1 : 0;
      let best = -1;
      let bestO = r.snapOnset;
      for (let u = Math.max(floor, g.a - back); u <= g.a; u++) {
        const o = onsets[u * P + col] * os;
        if (o >= bestO) {
          bestO = o;
          best = u;
        }
      }
      if (best >= 0 && best < g.a) {
        if (i > 0 && segs[i - 1].b >= best) segs[i - 1].b = best - 1;
        g.a = best;
      }
    }
  }
  const out: Note[] = [];
  for (const g of segs) {
    if (g.b < g.a) continue;
    const start = frameToTime(g.a);
    const end = frameToTime(g.b + 1);
    if ((end - start) * 1000 < r.minMs) continue;
    const col = lo + g.k;
    let sum = 0;
    for (let u = g.a; u <= g.b; u++) sum += frames[u * P + col] * fs;
    const mean = sum / (g.b - g.a + 1);
    if (mean < r.minMean) continue;
    let on = 0;
    for (let u = Math.max(0, g.a - 2); u <= Math.min(nFrames - 1, g.a + 3); u++) on = Math.max(on, onsets[u * P + col] * os);
    if (on < r.weakOnset && mean < r.weakMean) continue;
    const vel = Math.max(0.15, Math.min(1, 0.3 + 0.5 * Math.min(1, mean) + 0.2 * on));
    out.push({ id: newNoteId(), midi: col + BP_MIDI_OFFSET, start, dur: end - start, vel, hand: 'L' });
  }
  return out;
}

/** Mean frame activation of `midi` in the bass stem's posteriors over [t0, t1] (0 outside the range). */
export function bassActivation(post: BassPosteriors, midi: number, t0: number, t1: number): number {
  const f = midi - BP_MIDI_OFFSET;
  if (f < 0 || f >= BP_N_PITCHES || post.nFrames < 1) return 0;
  const a = Math.min(post.nFrames - 1, timeToFrame(Math.max(0, t0)));
  const b = Math.min(post.nFrames - 1, Math.max(a, timeToFrame(t1)));
  let s = 0;
  for (let t = a; t <= b; t++) s += post.frames[t * BP_N_PITCHES + f];
  return (s / (b - a + 1)) * scaleOf(post.frames);
}

export interface BassMergeRule {
  /** accompaniment notes up to this pitch can be replaced by the bass line */
  maxMidi: number;
  /** a low note is the bass stem's when that stem's activation of its pitch (or the octave below) over its first `window` s is at least this */
  explained: number;
  window: number;
  /** ...or when it has the pitch class of a bass-line note sounding at its start (±`near` s) and lies below this pitch */
  pcBelow: number;
  near: number;
}

export const BASS_MERGE: BassMergeRule = { maxMidi: 55, explained: 0.25, window: 0.06, pcBelow: 48, near: 0.06 };

/**
 * Whether accompaniment note `n` is the bass stem's (and so replaced by the bass line): low enough,
 * and either the bass stem's own pass hears its pitch (or the octave below: an overtone) at its
 * start, or it repeats the pitch class of the bass-line note sounding then (re-strike, octave
 * duplicate). Low notes the bass stem does not explain (a piano's left hand in "other") stay.
 */
export function bassExplained(n: Note, post: BassPosteriors, line: Note[], rule: BassMergeRule = BASS_MERGE): boolean {
  if (n.midi > rule.maxMidi) return false;
  const t1 = n.start + rule.window;
  if (bassActivation(post, n.midi, n.start, t1) >= rule.explained) return true;
  if (bassActivation(post, n.midi - 12, n.start, t1) >= rule.explained) return true;
  if (n.midi >= rule.pcBelow) return false;
  for (const b of line) {
    if (b.start > n.start + rule.near) break;
    if (b.start + b.dur >= n.start - rule.near && (b.midi - n.midi) % 12 === 0) return true;
  }
  return false;
}

/** `notes` with the low notes the bass stem explains replaced by the bass line (time-sorted). */
export function mergeBassLine(notes: Note[], line: Note[], post: BassPosteriors, rule: BassMergeRule = BASS_MERGE): Note[] {
  if (!line.length) return notes;
  const sortedLine = sortNotes(line);
  const kept = notes.filter((n) => !bassExplained(n, post, sortedLine, rule));
  return sortNotes([...kept, ...sortedLine]);
}
