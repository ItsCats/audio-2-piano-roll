/**
 * Lead-line recovery for the "Full song" preset: notes of the instruments' tune that the main
 * detection thresholds miss, taken from a second, more sensitive extraction of the SAME model
 * posteriors (ExtractionParams.leadPass; no second model run) and kept only where the tune line
 * goes through them.
 *
 * Why: in a band mix the lead instrument is often not the loudest pitch in Basic Pitch's output.
 * On band-instrumental-1 (an instrumental band track) about 70 % of the missing lead time had
 * frame posteriors below the "Full song" frame threshold (0.35), usually because a louder backing
 * pitch sounded at the same time, and the gliding, vibrato solo came out as 35-104 ms events that
 * minNoteMs (100 ms) drops; Hard caught 20 % of the solo's notes. The "Sensitive" preset's
 * thresholds (frame 0.25, 50 ms) catch most of them, but applied to everything they add 500-700
 * notes to the song (+36 %), only about 13 % of them on the lead, plus false low notes. Here the
 * sensitive pass only proposes candidates; the instruments' tune line (melody.ts instrumentLine,
 * the same Viterbi best path Easy and Medium follow) is run over the main notes plus the
 * candidates, and a candidate is kept only when the line picks it and the posteriors support it.
 *
 * Pure: the pipeline (transcription/pipeline.ts accompFromRaw) cleans the candidates and supplies
 * their frame evidence.
 */
import type { Note } from './types';
import { assignHands } from './hands';
import { instrumentLine, tuneCandidates } from './melody';
import { sortNotes } from './cleanup';

export interface LeadRecoveryRule {
  /** candidates outside this pitch range are not considered (the lead's register) */
  minMidi: number;
  maxMidi: number;
  /** mean frame activation of the candidate's pitch over the note (0..1) at least this */
  minMean: number;
  /** strongest ±1/±2 semitone neighbour over its first frames, relative to its own, below this */
  maxSpread: number;
  /** at most this many recovered notes per second in any `capWindow`-second window */
  maxPerSec: number;
  capWindow: number;
  /** a same-pitch main note covering at least this share of the candidate: already there */
  coveredShare: number;
  /** a main note one semitone away starting within this many seconds: the same (gliding) note */
  glideStart: number;
  /** recovered notes shorter than this (s) after trimming are dropped */
  minDur: number;
}

/** Selection rule (see the measurements in transcription/pipeline.ts EXTRACTION_PRESETS.mix.leadPass). */
export const LEAD_RECOVERY: LeadRecoveryRule = {
  minMidi: 60,
  maxMidi: 100,
  minMean: 0.25,
  maxSpread: 1.5,
  maxPerSec: 4,
  capWindow: 4,
  coveredShare: 0.5,
  glideStart: 0.04,
  minDur: 0.04,
};

export interface LeadRecoveryOptions {
  rule?: Partial<LeadRecoveryRule>;
  /** frame evidence of a candidate (transcription/pipeline.ts noteActivation); without it no evidence test is made */
  evidence?: (n: Note) => { mean: number; spread: number };
  /** time ranges (s) where nothing is recovered (e.g. sung phrases: the sung line is the tune there) */
  exclude?: [number, number][];
  /** mark the recovered notes Hard-only (role 'lead'; the pipeline always does) */
  hardOnly?: boolean;
}

function overlap(a: Note, b: Note): number {
  return Math.max(0, Math.min(a.start + a.dur, b.start + b.dur) - Math.max(a.start, b.start));
}

/**
 * Candidates not already present in `base`: no same-pitch main note covering `coveredShare` of
 * them, no main note a semitone away starting together (a glide between two keys). A candidate that
 * runs into a later same-pitch main note is cut where that note starts; one starting inside a main
 * note of its pitch is dropped.
 */
export function freshCandidates(base: Note[], candidates: Note[], rule: LeadRecoveryRule = LEAD_RECOVERY): Note[] {
  const sorted = sortNotes(base);
  let maxDur = 0;
  for (const n of sorted) maxDur = Math.max(maxDur, n.dur);
  const starts = sorted.map((n) => n.start);
  const lowerBound = (t: number) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out: Note[] = [];
  for (const c of candidates) {
    if (c.midi < rule.minMidi || c.midi > rule.maxMidi) continue;
    let end = c.start + c.dur;
    let keep = true;
    for (let i = lowerBound(c.start - maxDur); i < sorted.length && sorted[i].start < end; i++) {
      const b = sorted[i];
      const d = Math.abs(b.midi - c.midi);
      if (d === 1 && Math.abs(b.start - c.start) <= rule.glideStart) {
        keep = false;
        break;
      }
      if (d !== 0) continue;
      const ov = overlap(b, { ...c, dur: end - c.start });
      if (ov <= 0) continue;
      if (ov >= rule.coveredShare * c.dur || b.start <= c.start) {
        keep = false;
        break;
      }
      end = b.start - 0.005;
    }
    if (keep && end - c.start >= rule.minDur) out.push(end - c.start < c.dur ? { ...c, dur: end - c.start } : c);
  }
  return out;
}

/** Keep at most maxPerSec × capWindow notes in any capWindow-second window, strongest (by `score`) first. */
export function capDensity(notes: Note[], score: (n: Note) => number, rule: LeadRecoveryRule = LEAD_RECOVERY): Note[] {
  const max = Math.max(1, Math.floor(rule.maxPerSec * rule.capWindow));
  const kept: Note[] = [];
  for (const n of [...notes].sort((a, b) => score(b) - score(a))) {
    // windows containing n: any [t, t + capWindow] with t in [n.start - capWindow, n.start]
    const near = kept.filter((k) => Math.abs(k.start - n.start) < rule.capWindow).map((k) => k.start);
    near.push(n.start);
    near.sort((a, b) => a - b);
    // the fullest window starts at one of these notes
    let ok = true;
    for (let i = 0, j = 0; i < near.length; i++) {
      while (j < near.length && near[j] < near[i] + rule.capWindow) j++;
      if (j - i > max) {
        ok = false;
        break;
      }
    }
    if (ok) kept.push(n);
  }
  return sortNotes(kept);
}

function inRanges(ranges: [number, number][] | undefined, t: number): boolean {
  if (!ranges) return false;
  for (const [a, b] of ranges) if (t >= a && t < b) return true;
  return false;
}

/**
 * `base` (cleaned main notes) plus the lead candidates the instruments' tune line goes through.
 * Returns the main notes unchanged (same objects) plus the recovered notes, time-sorted; hands
 * are assigned later as for any transcription.
 */
export function recoverLead(base: Note[], candidates: Note[], duration: number, opts: LeadRecoveryOptions = {}): Note[] {
  const rule = { ...LEAD_RECOVERY, ...opts.rule };
  const fresh = freshCandidates(base, candidates, rule).filter((c) => !inRanges(opts.exclude, c.start));
  if (!fresh.length) return base;
  const freshIds = new Set(fresh.map((n) => n.id));
  const all = assignHands(sortNotes([...base, ...fresh]), duration);
  const line = instrumentLine(tuneCandidates(all));
  const onLine = new Set(line.filter((n) => freshIds.has(n.id)).map((n) => n.id));
  const ev = new Map<number, { mean: number; spread: number }>();
  const picked = fresh.filter((c) => {
    if (!onLine.has(c.id)) return false;
    if (!opts.evidence) return true;
    const e = opts.evidence(c);
    ev.set(c.id, e);
    return e.mean >= rule.minMean && e.spread < rule.maxSpread;
  });
  let kept = capDensity(picked, (n) => ev.get(n.id)?.mean ?? n.vel, rule);
  if (opts.hardOnly) kept = kept.map((n) => ({ ...n, role: 'lead' as const }));
  return kept.length ? sortNotes([...base, ...kept]) : base;
}
