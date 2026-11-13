/**
 * "Full song + piano model": the piano model's notes (lib/pianoSpecialist, run on the separated
 * "other" stem) blended into the Full song result, note by note, without moving it.
 *
 * Why: on the band test song the piano model hears what Basic Pitch misses in a band mix: the
 * band's keyboard part (63 % of a multi-instrument transcriber's piano notes at the exact pitch vs
 * 24 %), riffs and the notes between the melody, and some lead notes in holes of the tune line; it
 * is much worse at the tune on top (lead on top at 23-26 % of lead onsets vs 53 %), at the bass
 * (15-26 vs 68 % of the bass notes) and at octaves the song doubles. So the Full song notes stay as
 * they are (tune line, bass line, hands) and the piano model only adds notes:
 *   - lead notes in holes of the tune line (blendLeadCandidates; through music/leadRecovery.ts
 *     `extra`, so they get the roles recovered lead notes get),
 *   - fills: keyboard parts and in-between notes at least `below` semitones under the tune note
 *     sounding (or where no tune note sounds), with density and hand caps (blendFills).
 * Two rules are built but off (PIANO_BLEND.octave.enabled, .riff.enabled) until they meet their
 * own measurement bars: moving a tune note to the piano model's octave, and letting fills go above
 * the tune where the tune line is sparse and the piano model plays a riff.
 *
 * The thresholds are starting points from the design measurements; they are not tuned yet.
 *
 * Pure: the pipeline (transcription/pipeline.ts accompFromRaw) supplies Basic Pitch's evidence.
 */
import type { Note } from './types';
import type { RegressionOutputs } from '../pianoSpecialist/postprocess';
import { PTI_BEGIN_NOTE, PTI_N_PITCHES, regressionToNotes } from '../pianoSpecialist/postprocess';
import { newNoteId, sortNotes } from './cleanup';
import { LEAD_RECOVERY, capDensity } from './leadRecovery';
import { assignHands, clusterOnsets, handBySplit } from './hands';

/** One note of the piano model, with the evidence the blend uses (stored: StoredPosteriors.specialist). */
export interface SpecNote {
  start: number;
  dur: number;
  midi: number;
  /** velocity 0..1 */
  vel: number;
  /** strongest regressed onset of its pitch within ±2 frames of its start (0..1) */
  onsetPeak: number;
  /** mean frame probability of its pitch over the note (0..1) */
  frameMean: number;
}

/** Numbers per SpecNote in the stored form (packSpecNotes). */
export const SPEC_NOTE_FIELDS = 6;

export interface PianoBlendRule {
  /** the piano model's onsets come ~5-7 ms before Basic Pitch's: shifted by this (s) */
  shift: number;
  /** same-pitch fragments with a gap below `joinGap` s are one note unless Basic Pitch hears a rise of `joinRise` there */
  joinGap: number;
  joinRise: number;
  /** relative velocity: to the loudest piano-model note starting within this many seconds */
  relVelWindow: number;
  /** a piano-model note with an app note of the same pitch starting within this many seconds is already there */
  match: number;
  /** no notes below this pitch (the bass line is the Full song's) */
  minMidi: number;
  /** notes up to this pitch need Basic Pitch frame evidence `lowBpMean` and no bass-line note of their pitch class */
  lowMax: number;
  lowBpMean: number;
  /** drum hit: a drum onset of at least `drumHit` (8-bit) within ±`drumWindow` s, Basic Pitch onset below `drumBpOn` and shorter than `drumDur` s */
  drumHit: number;
  drumWindow: number;
  drumBpOn: number;
  drumDur: number;
  /** overtone: an app note this many semitones below sounds and Basic Pitch's mean is below `harmonicBpMean` */
  harmonicIntervals: number[];
  harmonicBpMean: number;
  /** inside a sounding app note of its pitch: kept only with a Basic Pitch frame rise of at least this */
  continuationRise: number;
  /** shorter notes are dropped (s) */
  minDur: number;
  hole: {
    /** a gap of at least this (s) between consecutive tune-line notes */
    minGap: number;
    /** no tune-line note sounding within this many seconds of the candidate's start */
    clear: number;
    /** within this many semitones of the line between the hole's neighbors (`farNear` when they are more than `farGap` s apart) */
    near: number;
    farNear: number;
    farGap: number;
    relVel: number;
    onsetPeak: number;
    /** Basic Pitch frame mean at least this, or the stem pitch track at its pitch class */
    bpMean: number;
    /** inserts per second of hole */
    perSec: number;
    /** onset cluster width (s): only its highest qualifying note */
    cluster: number;
  };
  octave: {
    enabled: boolean;
    /** the piano model has the octave above / below within this many seconds of the tune note's start ... */
    window: number;
    /** ... and nothing at its pitch within this many seconds */
    absent: number;
    onsetPeak: number;
    relVel: number;
    /** Basic Pitch's mean at the other octave at least this share of its mean at the tune note's pitch */
    bpRatio: number;
    /** the moved note stays within this many semitones of its line neighbors */
    near: number;
  };
  fill: {
    /** fuse = 0.45·onsetPeak + 0.35·min(1, bpMean / bpFull) + 0.20·relVel */
    fuse: number;
    bpFull: number;
    onsetPeak: number;
    bpMean: number;
    /** at least this many semitones below the tune note sounding at its start */
    below: number;
    /** held to Basic Pitch's held end of its pitch, at least this long (s) */
    minDur: number;
    /** at most `perSec` added notes per second in any `window`-second window */
    perSec: number;
    window: number;
    /** at most this many right-hand / left-hand notes per onset cluster (app + added; bass-line notes not counted) */
    rh: number;
    lh: number;
    cluster: number;
  };
  riff: {
    enabled: boolean;
    /** segment length (s); a riff passage is at least `minSegs` consecutive segments where ... */
    seg: number;
    minSegs: number;
    /** ... the tune line has at most this many onsets per second ... */
    maxTuneRate: number;
    /** ... and the piano model's strong notes (fuse at least `fuse`) make at least `minRate` notes per second with a median length of at least `minMedian` s */
    fuse: number;
    minRate: number;
    minMedian: number;
  };
}

/** Starting thresholds (design: docs/TRANSCRIPTION.md §3c); tuning is the next step. */
export const PIANO_BLEND: PianoBlendRule = {
  shift: 0.005,
  joinGap: 0.06,
  joinRise: 0.15,
  relVelWindow: 0.05,
  match: 0.08,
  minMidi: 43,
  lowMax: 54,
  lowBpMean: 0.3,
  drumHit: 128,
  drumWindow: 0.03,
  drumBpOn: 0.3,
  drumDur: 0.15,
  harmonicIntervals: [12, 19, 24],
  harmonicBpMean: 0.15,
  continuationRise: 0.15,
  minDur: 0.05,
  hole: { minGap: 0.2, clear: 0.06, near: 5, farNear: 7, farGap: 1, relVel: 0.8, onsetPeak: 0.5, bpMean: 0.08, perSec: 3, cluster: 0.05 },
  octave: { enabled: false, window: 0.06, absent: 0.08, onsetPeak: 0.6, relVel: 0.9, bpRatio: 0.5, near: 7 },
  fill: { fuse: 0.55, bpFull: 0.25, onsetPeak: 0.4, bpMean: 0.05, below: 3, minDur: 0.12, perSec: 4, window: 2, rh: 4, lh: 3, cluster: 0.05 },
  riff: { enabled: false, seg: 2, minSegs: 2, maxTuneRate: 1.25, fuse: 0.6, minRate: 3, minMedian: 0.12 },
};

// ---------------------------------------------------------------- the piano model's notes

/**
 * The piano model's notes (its own post-processor, pianoSpecialist/postprocess.ts, default
 * thresholds) with their onset peak and frame mean read from its output maps; notes starting past
 * `duration` are dropped. The maps are not needed afterwards.
 */
export function specNotesFromOutputs(o: RegressionOutputs, duration: number): SpecNote[] {
  const notes = regressionToNotes(o).filter((n) => n.start < duration);
  const P = PTI_N_PITCHES;
  const last = o.nFrames - 1;
  return notes.map((n) => {
    const k = n.midi - PTI_BEGIN_NOTE;
    const f0 = Math.max(0, Math.min(last, Math.round(n.start * o.fps)));
    let peak = 0;
    for (let t = Math.max(0, f0 - 2); t <= Math.min(last, f0 + 2); t++) peak = Math.max(peak, o.onset[t * P + k]);
    const f1 = Math.max(f0, Math.min(last, Math.round((n.start + n.dur) * o.fps)));
    let sum = 0;
    for (let t = f0; t <= f1; t++) sum += o.frame[t * P + k];
    return { start: n.start, dur: n.dur, midi: n.midi, vel: n.vel, onsetPeak: Math.min(1, peak), frameMean: sum / (f1 - f0 + 1) };
  });
}

/** SpecNotes as one Float32Array of SPEC_NOTE_FIELDS numbers each (about 0.4 KB per second of a band song). */
export function packSpecNotes(notes: SpecNote[]): Float32Array {
  const out = new Float32Array(notes.length * SPEC_NOTE_FIELDS);
  notes.forEach((n, i) => out.set([n.start, n.dur, n.midi, n.vel, n.onsetPeak, n.frameMean], i * SPEC_NOTE_FIELDS));
  return out;
}

export function unpackSpecNotes(a: Float32Array | ArrayLike<number>): SpecNote[] {
  const out: SpecNote[] = [];
  for (let i = 0; i + SPEC_NOTE_FIELDS <= a.length; i += SPEC_NOTE_FIELDS) {
    out.push({ start: a[i], dur: a[i + 1], midi: Math.round(a[i + 2]), vel: a[i + 3], onsetPeak: a[i + 4], frameMean: a[i + 5] });
  }
  return out;
}

// ---------------------------------------------------------------- evidence and preparation

/** Basic Pitch's evidence (accompaniment posteriors) and the other cues, supplied by the pipeline. */
export interface BlendEvidence {
  /** mean frame activation of `midi` over [t0, t1] (0..1) */
  mean: (midi: number, t0: number, t1: number) => number;
  /** onset posterior peak of `midi` around t (0..1) */
  onset: (midi: number, t: number) => number;
  /** frame activation rise of `midi` at t (0..1) */
  rise: (midi: number, t: number) => number;
  /** strongest drum onset (8-bit) in [t0, t1] (absent: no drum test) */
  drum?: (t0: number, t1: number) => number;
  /** the stem pitch track is at `midi`'s pitch class over [t0, t1] (absent: no such cue) */
  pitchAgrees?: (midi: number, t0: number, t1: number) => boolean;
  /** end (s) of a note held while Basic Pitch still hears its pitch, at most `limit` */
  heldEnd?: (midi: number, start: number, end: number, limit: number) => number;
}

/** A piano-model note after preparation, with the Basic Pitch evidence at it. */
export interface PreparedNote extends SpecNote {
  relVel: number;
  bpMean: number;
  bpOn: number;
  /** an app note of the same pitch starts within PIANO_BLEND.match s */
  matched: boolean;
}

const sounding = (n: Note, t: number) => n.start <= t && t < n.start + n.dur;

/** Sorted-by-start index of notes, for "what sounds at t" queries. */
class NoteIndex {
  private notes: Note[];
  private starts: number[];
  private maxDur: number;
  constructor(notes: Note[]) {
    this.notes = sortNotes(notes);
    this.starts = this.notes.map((n) => n.start);
    this.maxDur = this.notes.reduce((m, n) => Math.max(m, n.dur), 0);
  }
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** notes starting in [t0, t1] */
  startingIn(t0: number, t1: number): Note[] {
    const out: Note[] = [];
    for (let i = this.lowerBound(t0); i < this.notes.length && this.notes[i].start <= t1; i++) out.push(this.notes[i]);
    return out;
  }
  /** notes sounding at t */
  at(t: number): Note[] {
    const out: Note[] = [];
    for (let i = this.lowerBound(t - this.maxDur); i < this.notes.length && this.notes[i].start <= t; i++) if (sounding(this.notes[i], t)) out.push(this.notes[i]);
    return out;
  }
  /** notes overlapping [t0, t1) */
  overlapping(t0: number, t1: number): Note[] {
    const out: Note[] = [];
    for (let i = this.lowerBound(t0 - this.maxDur); i < this.notes.length && this.notes[i].start < t1; i++) {
      const n = this.notes[i];
      if (n.start + n.dur > t0) out.push(n);
    }
    return out;
  }
}

/** Same-pitch fragments of the piano model joined where Basic Pitch hears no new attack (PianoBlendRule.joinGap). */
export function joinFragments(spec: SpecNote[], ev: Pick<BlendEvidence, 'rise'>, rule: PianoBlendRule = PIANO_BLEND): SpecNote[] {
  const byPitch = new Map<number, SpecNote[]>();
  for (const n of spec) {
    let a = byPitch.get(n.midi);
    if (!a) byPitch.set(n.midi, (a = []));
    a.push({ ...n });
  }
  const out: SpecNote[] = [];
  for (const a of byPitch.values()) {
    a.sort((x, y) => x.start - y.start);
    let cur = a[0];
    for (let i = 1; i < a.length; i++) {
      const n = a[i];
      const gap = n.start - (cur.start + cur.dur);
      if (gap < rule.joinGap && ev.rise(n.midi, n.start) < rule.joinRise) {
        const end = Math.max(cur.start + cur.dur, n.start + n.dur);
        const w0 = cur.dur;
        const w1 = n.dur;
        cur = { ...cur, dur: end - cur.start, frameMean: (cur.frameMean * w0 + n.frameMean * w1) / Math.max(1e-6, w0 + w1) };
      } else {
        out.push(cur);
        cur = n;
      }
    }
    out.push(cur);
  }
  return out.sort((x, y) => x.start - y.start || x.midi - y.midi);
}

/**
 * The piano model's notes the blend may use: shifted, fragments joined, relative velocity and Basic
 * Pitch's evidence attached; dropped are notes below the Full song's left-hand register (or low ones
 * without Basic Pitch evidence or that the bass line explains), drum hits, overtones of app notes,
 * re-detections inside a sounding app note of the same pitch, and very short notes. `app` is the
 * Full song's notes (with the bass line).
 */
export function prepareSpecialist(spec: SpecNote[], app: Note[], ev: BlendEvidence, rule: PianoBlendRule = PIANO_BLEND): PreparedNote[] {
  const shifted = spec.map((n) => ({ ...n, start: n.start + rule.shift }));
  const joined = joinFragments(shifted, ev, rule).filter((n) => n.dur >= rule.minDur && n.midi >= rule.minMidi);
  // relative velocity within the onset cluster (sorted by start: a two-pointer window)
  const byStart = [...joined].sort((a, b) => a.start - b.start);
  const rel = new Map<SpecNote, number>();
  for (let i = 0, lo = 0, hi = 0; i < byStart.length; i++) {
    const t = byStart[i].start;
    while (byStart[lo].start < t - rule.relVelWindow) lo++;
    while (hi < byStart.length && byStart[hi].start <= t + rule.relVelWindow) hi++;
    let m = 0;
    for (let k = lo; k < hi; k++) m = Math.max(m, byStart[k].vel);
    rel.set(byStart[i], m > 0 ? byStart[i].vel / m : 1);
  }
  const idx = new NoteIndex(app);
  const bassLine = app.filter((n) => n.role === 'bass');
  const out: PreparedNote[] = [];
  for (const n of byStart) {
    const end = n.start + n.dur;
    const bpMean = ev.mean(n.midi, n.start, end);
    const bpOn = ev.onset(n.midi, n.start);
    if (n.midi <= rule.lowMax) {
      if (bpMean < rule.lowBpMean) continue;
      if (bassLine.some((b) => sounding(b, n.start + 0.02) && (b.midi - n.midi) % 12 === 0)) continue;
    }
    if (ev.drum && n.dur < rule.drumDur && bpOn < rule.drumBpOn && ev.drum(n.start - rule.drumWindow, n.start + rule.drumWindow) >= rule.drumHit) continue;
    const near = idx.at(n.start + 0.02);
    if (bpMean < rule.harmonicBpMean && near.some((a) => rule.harmonicIntervals.includes(n.midi - a.midi))) continue;
    const matched = idx.startingIn(n.start - rule.match, n.start + rule.match).some((a) => a.midi === n.midi);
    if (!matched && near.some((a) => a.midi === n.midi) && ev.rise(n.midi, n.start) < rule.continuationRise) continue;
    out.push({ ...n, relVel: rel.get(n) ?? 1, bpMean, bpOn, matched });
  }
  return out;
}

// ---------------------------------------------------------------- lead notes in holes of the tune line

/**
 * Lead candidates in holes of the tune line (`line`: the Full song's tune line, time-sorted): a gap
 * of at least hole.minGap s between consecutive line notes, a piano-model note there that no app note
 * matches, that no line note sounds near, close to the line between the hole's neighbors, loud in its
 * cluster with a clear onset, heard by Basic Pitch or the stem pitch track, and the highest such note
 * of its cluster; at most hole.perSec per second of hole (strongest first). Returned as notes for
 * music/leadRecovery.ts `extra` (src 'piano').
 */
export function blendLeadCandidates(prepared: PreparedNote[], line: Note[], ev: Pick<BlendEvidence, 'pitchAgrees'> = {}, rule: PianoBlendRule = PIANO_BLEND): Note[] {
  const h = rule.hole;
  const L = sortNotes(line);
  if (L.length < 2) return [];
  const cands = prepared.filter((p) => !p.matched).sort((a, b) => a.start - b.start);
  const out: Note[] = [];
  let ci = 0;
  for (let i = 0; i + 1 < L.length; i++) {
    const a = L[i];
    const b = L[i + 1];
    const t0 = a.start + a.dur;
    const t1 = b.start;
    if (t1 - t0 < h.minGap) continue;
    while (ci < cands.length && cands[ci].start < t0 + h.clear) ci++;
    const tol = t1 - t0 > h.farGap ? h.farNear : h.near;
    const q: PreparedNote[] = [];
    for (let k = ci; k < cands.length && cands[k].start <= t1 - h.clear; k++) {
      const c = cands[k];
      const f = (c.start - t0) / (t1 - t0);
      const want = a.midi + (b.midi - a.midi) * f;
      if (Math.abs(c.midi - want) > tol) continue;
      if (c.relVel < h.relVel || c.onsetPeak < h.onsetPeak) continue;
      if (c.bpMean < h.bpMean && !ev.pitchAgrees?.(c.midi, c.start, c.start + Math.min(c.dur, 0.15))) continue;
      q.push(c);
    }
    // the highest note of each onset cluster
    const top = clusterOnsets(q, h.cluster).map((cl) => cl.reduce((x, y) => (y.midi > x.midi ? y : x)));
    const cap = Math.max(1, Math.floor(h.perSec * (t1 - t0)));
    const kept = top
      .sort((x, y) => y.onsetPeak * y.relVel - x.onsetPeak * x.relVel)
      .slice(0, cap)
      .sort((x, y) => x.start - y.start);
    kept.forEach((c, k) => {
      const next = k + 1 < kept.length ? kept[k + 1].start : t1;
      const dur = Math.max(0.03, Math.min(c.dur, next - c.start - 0.005));
      out.push({ id: newNoteId(), midi: c.midi, start: c.start, dur, vel: noteVel(c.vel), hand: 'R', src: 'piano' });
    });
  }
  return out;
}

/** The piano model's velocity on the app's scale (0.15..1). */
const noteVel = (v: number) => Math.max(0.15, Math.min(1, v));

// ---------------------------------------------------------------- octave rule (off)

/**
 * Tune notes moved to the octave the piano model plays them in (PianoBlendRule.octave; off by
 * default: on the band test song the piano model has the wrong octave louder in a third of the app's
 * octave slips, because the song doubles its tune in octaves). Returns the notes and how many moved.
 */
export function octaveFixes(notes: Note[], line: Note[], prepared: PreparedNote[], ev: Pick<BlendEvidence, 'mean'>, rule: PianoBlendRule = PIANO_BLEND): { notes: Note[]; moved: number } {
  const o = rule.octave;
  if (!o.enabled || !line.length || !prepared.length) return { notes, moved: 0 };
  const L = sortNotes(line);
  const byStart = [...prepared].sort((a, b) => a.start - b.start);
  const near = (t: number, w: number) => byStart.filter((p) => Math.abs(p.start - t) <= w);
  const move = new Map<number, number>();
  L.forEach((a, i) => {
    const ps = near(a.start, Math.max(o.window, o.absent));
    if (ps.some((p) => p.midi === a.midi && Math.abs(p.start - a.start) <= o.absent)) return;
    for (const d of [12, -12]) {
      const p = ps.find((x) => x.midi === a.midi + d && Math.abs(x.start - a.start) <= o.window && x.onsetPeak >= o.onsetPeak && x.relVel >= o.relVel);
      if (!p) continue;
      const end = a.start + a.dur;
      if (ev.mean(a.midi + d, a.start, end) < o.bpRatio * ev.mean(a.midi, a.start, end)) continue;
      const prev = L[i - 1];
      const next = L[i + 1];
      const m = a.midi + d;
      if ((prev && Math.abs(prev.midi - m) > o.near) || (next && Math.abs(next.midi - m) > o.near)) continue;
      move.set(a.id, m);
      break;
    }
  });
  if (!move.size) return { notes, moved: 0 };
  return { notes: notes.map((n) => (move.has(n.id) ? { ...n, midi: move.get(n.id)! } : n)), moved: move.size };
}

// ---------------------------------------------------------------- fills

/** How strongly both models support a piano-model note (PianoBlendRule.fill.fuse). */
export function fuseScore(p: Pick<PreparedNote, 'onsetPeak' | 'bpMean' | 'relVel'>, rule: PianoBlendRule = PIANO_BLEND): number {
  return 0.45 * p.onsetPeak + 0.35 * Math.min(1, p.bpMean / rule.fill.bpFull) + 0.2 * p.relVel;
}

/**
 * Riff passages (PianoBlendRule.riff): runs of at least riff.minSegs segments where the tune line is
 * sparse and the piano model plays a steady figure. Time ranges (s).
 */
export function riffPassages(line: Note[], prepared: PreparedNote[], duration: number, rule: PianoBlendRule = PIANO_BLEND): [number, number][] {
  const r = rule.riff;
  const nSeg = Math.max(0, Math.ceil(duration / r.seg));
  const flags: boolean[] = [];
  for (let s = 0; s < nSeg; s++) {
    const a = s * r.seg;
    const b = a + r.seg;
    const tune = line.filter((n) => n.start >= a && n.start < b).length / r.seg;
    const strong = prepared.filter((p) => p.start >= a && p.start < b && fuseScore(p, rule) >= r.fuse);
    const durs = strong.map((p) => p.dur).sort((x, y) => x - y);
    const median = durs.length ? durs[durs.length >> 1] : 0;
    flags.push(tune <= r.maxTuneRate && strong.length / r.seg >= r.minRate && median >= r.minMedian);
  }
  const out: [number, number][] = [];
  for (let s = 0; s < nSeg; ) {
    if (!flags[s]) {
      s++;
      continue;
    }
    let e = s;
    while (e < nSeg && flags[e]) e++;
    if (e - s >= r.minSegs) out.push([s * r.seg, e * r.seg]);
    s = e;
  }
  return out;
}

const inRanges = (ranges: [number, number][], t: number) => ranges.some(([a, b]) => t >= a && t < b);

/**
 * `notes` plus the fills: unmatched piano-model notes both models support (fuse), at least fill.below
 * semitones under the tune note sounding at their start (any pitch where none sounds, or inside a riff
 * passage), held to Basic Pitch's held end but ended before a later tune note it would sit less than
 * fill.below under, strongest first under the density cap and the per-cluster hand caps. Fills get the hand of the split the app's notes make (music/hands.ts handBySplit) and
 * src 'piano', no role. The app's notes are returned as the same objects.
 */
export function blendFills(
  notes: Note[],
  prepared: PreparedNote[],
  line: Note[],
  duration: number,
  ev: Pick<BlendEvidence, 'heldEnd'> = {},
  opts: { riff?: [number, number][]; skip?: Set<PreparedNote> } = {},
  rule: PianoBlendRule = PIANO_BLEND,
): { notes: Note[]; fills: Note[] } {
  const f = rule.fill;
  const riff = opts.riff ?? [];
  const lineIdx = new NoteIndex(line);
  const appIdx = new NoteIndex(notes);
  // the app's hands as the arrangement will have them (melody.ts mergeMelody: Hard-only notes aside)
  const handed = assignHands(sortNotes(notes.filter((n) => n.role !== 'lead')), duration);
  const hand = handBySplit(handed, duration);
  const cands: { n: Note; s: number }[] = [];
  for (const p of prepared) {
    if (p.matched || opts.skip?.has(p)) continue;
    const s = fuseScore(p, rule);
    if (s < f.fuse || p.onsetPeak < f.onsetPeak || p.bpMean < f.bpMean) continue;
    const tune = lineIdx.at(p.start + 0.02);
    if (tune.length && !inRanges(riff, p.start) && tune.some((t) => p.midi > t.midi - f.below)) continue;
    let end = p.start + p.dur;
    const held = ev.heldEnd ? ev.heldEnd(p.midi, p.start, end, p.start + Math.max(p.dur, 2)) : end;
    end = Math.max(end, held, p.start + f.minDur);
    // the register rule holds for the whole fill: it ends where a tune note starts that it would sit
    // less than `below` under (a fill held over the next tune notes became the tune line on Easy)
    if (!inRanges(riff, p.start)) for (const t of lineIdx.startingIn(p.start + 0.02, end)) if (p.midi > t.midi - f.below) end = Math.min(end, t.start - 0.005);
    // not into a later app note of its pitch; nothing where one already sounds
    for (const a of appIdx.overlapping(p.start, end)) {
      if (a.midi !== p.midi) continue;
      if (a.start <= p.start + 0.02) {
        end = -1;
        break;
      }
      end = Math.min(end, a.start - 0.005);
    }
    if (end - p.start < rule.minDur) continue;
    cands.push({ n: { id: newNoteId(), midi: p.midi, start: p.start, dur: end - p.start, vel: noteVel(p.vel), hand: hand(p), src: 'piano' }, s });
  }
  if (!cands.length) return { notes, fills: [] };
  const score = new Map(cands.map((c) => [c.n.id, c.s]));
  const dense = capDensity(
    cands.map((c) => c.n),
    (n) => score.get(n.id) ?? 0,
    { ...LEAD_RECOVERY, maxPerSec: f.perSec, capWindow: f.window },
  );
  // per onset cluster: at most rh / lh notes per hand, app notes first (the bass line is not counted)
  type Item = { start: number; n: Note; add: boolean };
  const items: Item[] = [
    ...handed.filter((n) => n.role !== 'bass').map((n) => ({ start: n.start, n, add: false })),
    ...dense.map((n) => ({ start: n.start, n, add: true })),
  ].sort((a, b) => a.start - b.start);
  const fills: Note[] = [];
  for (const cl of clusterOnsets(items, f.cluster)) {
    let rh = 0;
    let lh = 0;
    for (const x of cl) if (!x.add) (x.n.hand === 'L' ? lh++ : rh++);
    const added = cl.filter((x) => x.add).sort((a, b) => (score.get(b.n.id) ?? 0) - (score.get(a.n.id) ?? 0));
    for (const x of added) {
      if (x.n.hand === 'L' ? lh >= f.lh : rh >= f.rh) continue;
      if (x.n.hand === 'L') lh++;
      else rh++;
      fills.push(x.n);
    }
  }
  return fills.length ? { notes: sortNotes([...notes, ...fills]), fills: sortNotes(fills) } : { notes, fills: [] };
}
