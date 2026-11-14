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
 * The posterior test runs BEFORE the line is chosen: a weak candidate the line would go through
 * (typically the faint octave above a lead note) used to win the line, fail the test afterwards
 * and leave a hole where the real lead note had been passed over (0:05.6 and 0:57-0:58 of
 * band-instrumental-1). It also asks for a model onset at the candidate's start (minOnset): the
 * sensitive pass's inferred onsets turn chord tones and held accompaniment into candidates that
 * have none. Candidates with a clear onset need less sustained activation (strongMinMean: fast
 * solo notes). After the line, a recovered note an octave above a much stronger main note is that
 * note's overtone and is dropped (overtoneRatio), and one attacked together with a clearly stronger
 * candidate an octave below is replaced by it (octaveAttack*). A candidate that re-strikes a main
 * note of the tune line, at least 0.2 s into it, splits it (splitRestrikes: repeated tune notes;
 * earlier re-attacks are mostly the onset head firing twice). The split pieces are main notes, so
 * Easy and Medium play the repeated tune note too.
 * Measured on band-instrumental-1 (separated, offline on the stored posteriors, estimated lead
 * reference): recovered notes on the lead at the exact pitch 38 -> 45 %, Hard lead-note recall
 * 63.1 -> 64.5 %, solo 80 -> 83 %, top-voice recall 49.9 -> 51.3 %; on the two references that
 * leave one of its sources out the recall gain is about half as large (68.3 -> 70.0, 67.3 -> 68.2).
 * These thresholds were chosen on that song (no second instrumental with a lead reference exists);
 * the five sung test songs (where sung phrases are excluded) were checked for regressions only.
 *
 * Pure: the pipeline (transcription/pipeline.ts accompFromRaw) cleans the candidates and supplies
 * their frame evidence.
 */
import type { Note } from './types';
import { assignHands } from './hands';
import { instrumentLine, tuneCandidates } from './melody';
import { newNoteId, sortNotes } from './cleanup';

export interface LeadRecoveryRule {
  /** candidates outside this pitch range are not considered (the lead's register) */
  minMidi: number;
  maxMidi: number;
  /** mean frame activation of the candidate's pitch over the note (0..1) at least this */
  minMean: number;
  /**
   * onset posterior of the candidate's pitch around its start at least this (when the evidence
   * reports one): a recovered note must be heard as a new attack, not a chord tone or overtone that
   * the sensitive pass's inferred onsets turned into a note
   */
  minOnset: number;
  /** a candidate with an onset of at least `strongOnset` needs only this mean activation */
  strongOnset: number;
  strongMinMean: number;
  /** strongest ±1/±2 semitone neighbour over its first frames, relative to its own, below this */
  maxSpread: number;
  /**
   * a candidate an octave above a main note sounding at its start whose mean activation is
   * below this share of that note's is the note's overtone, not a lead note (0: no test)
   */
  overtoneRatio: number;
  /**
   * a recovered note attacked within `octaveAttackWindow` s of a note an octave below (a main note or
   * another candidate that passed the evidence test) whose mean activation is below
   * `octaveAttackRatio` × that note's is the lower note's overtone onset: it is dropped, or, when the
   * lower note is a candidate, replaced by it (0: no test)
   */
  octaveAttackRatio: number;
  octaveAttackWindow: number;
  /**
   * also against main notes (the recovered note is then dropped). Off: on band-instrumental-1 it
   * removed 3 recovered notes that are on the lead in all three references for 6 that are an octave
   * above it, and the main note already plays the lower octave either way
   */
  octaveAttackMain: boolean;
  /**
   * a candidate starting at least `restrikeAfter` s inside a main note of its pitch, with an onset of
   * at least `restrikeOnset` and a frame rise of at least `restrikeRise`, is a new attack of that
   * pitch the main pass ran through (a repeated tune note): the main note is split there. Only
   * main notes the tune line goes through are split
   */
  restrikeOnset: number;
  restrikeRise: number;
  restrikeAfter: number;
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
  minOnset: 0.45,
  strongOnset: 0.6,
  strongMinMean: 0.2,
  maxSpread: 1.5,
  overtoneRatio: 0.55,
  octaveAttackRatio: 0.67,
  octaveAttackWindow: 0.06,
  octaveAttackMain: false,
  restrikeOnset: 0.6,
  restrikeRise: 0.15,
  restrikeAfter: 0.2,
  maxPerSec: 4,
  capWindow: 4,
  coveredShare: 0.5,
  glideStart: 0.04,
  minDur: 0.04,
};

/** Frame evidence of a candidate: mean activation, neighbour spread and (optional) onset peak. */
export interface LeadEvidence {
  mean: number;
  spread: number;
  onset?: number;
  /** frame-activation rise at its start (pipeline frameRise) */
  rise?: number;
}

export interface LeadRecoveryOptions {
  rule?: Partial<LeadRecoveryRule>;
  /** frame evidence of a candidate (transcription/pipeline.ts noteActivation); without it no evidence test is made */
  evidence?: (n: Note) => LeadEvidence;
  /** time ranges (s) where nothing is recovered (e.g. sung phrases: the sung line is the tune there) */
  exclude?: [number, number][];
  /** mark the recovered notes Hard-only (role 'lead'; Easy and Medium are built without them) */
  hardOnly?: boolean;
  /**
   * (without hardOnly) mark Hard-only just the recovered notes struck with a main note an octave or
   * two away (an octave doubling of the tune or of the backing): Easy and Medium keep the main
   * pass's note there instead of jumping to the doubling (see LEAD_DOUBLE)
   */
  doublesHardOnly?: boolean;
  /**
   * Lead notes from another model (the piano model's hole inserts, music/pianoBlend.ts): they skip
   * the posterior test (Basic Pitch missing them is why they are here) and do not take part in the
   * tune line (so the notes it picks are the same with or without them); they still go through
   * `exclude`, freshCandidates (against the main notes and the recovered ones) and the
   * hardOnly / doublesHardOnly tagging.
   */
  extra?: Note[];
}

/** doublesHardOnly: a main note starting within `window` s of a recovered note, a whole number of octaves away, that still sounds `overlap` s in. */
export const LEAD_DOUBLE = { window: 0.08, overlap: 0.05 };

/** Whether recovered note `n` doubles a note of `base` an octave (or more) away (see LeadRecoveryOptions.doublesHardOnly). */
export function doublesMainNote(n: Note, base: Note[], rule = LEAD_DOUBLE): boolean {
  return base.some(
    (m) =>
      m.midi !== n.midi &&
      (m.midi - n.midi) % 12 === 0 &&
      Math.abs(m.start - n.start) <= rule.window &&
      m.start + m.dur > n.start + rule.overlap &&
      m.role !== 'bass' &&
      m.role !== 'lead',
  );
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
    if (keep && end - c.start >= rule.minDur) out.push(end < c.start + c.dur ? { ...c, dur: end - c.start } : c);
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

/**
 * Candidates that are a main note's overtone: an octave above a main note sounding 20 ms
 * after the candidate starts, with a mean activation below `ratio` × that note's. Basic Pitch lights
 * the octave above a loud note faintly; the sensitive pass turns that into a candidate which, being
 * on top, the tune line likes to take.
 */
export function overtoneCandidates(base: Note[], fresh: Note[], ratio: number, mean: (n: Note) => number): Set<Note> {
  const sorted = sortNotes(base);
  let maxDur = 0;
  for (const n of sorted) maxDur = Math.max(maxDur, n.dur);
  const out = new Set<Note>();
  let j = 0;
  for (const c of sortNotes(fresh)) {
    const t = c.start + 0.02;
    while (j < sorted.length && sorted[j].start < t - maxDur) j++;
    for (let i = j; i < sorted.length && sorted[i].start <= t; i++) {
      const b = sorted[i];
      const d = c.midi - b.midi;
      if (d === 12 && b.start + b.dur > t && mean(c) < ratio * mean(b)) {
        out.add(c);
        break;
      }
    }
  }
  return out;
}

/**
 * Recovered notes that are the octave-above shadow of another attack (LeadRecoveryRule
 * octaveAttack*): Basic Pitch's onset head fires on the octave above a new note too, and the
 * sensitive pass turns that into a candidate the tune line, preferring the top, takes. Returns, per
 * such note, the lower note to use instead: a candidate (from `lower`, the ones that passed the
 * evidence test) or undefined (a main note in `base` already plays it).
 */
export function octaveAttacks(
  picked: Note[],
  base: Note[],
  lower: Note[],
  ratio: number,
  window: number,
  mean: (n: Note) => number,
): Map<Note, Note | undefined> {
  const out = new Map<Note, Note | undefined>();
  if (!(ratio > 0) || !picked.length) return out;
  const byPitch = new Map<number, { n: Note; cand: boolean }[]>();
  const add = (n: Note, cand: boolean) => {
    let a = byPitch.get(n.midi);
    if (!a) byPitch.set(n.midi, (a = []));
    a.push({ n, cand });
  };
  for (const n of base) add(n, false);
  for (const n of lower) add(n, true);
  for (const c of picked) {
    let best: { n: Note; cand: boolean; r: number } | undefined;
    for (const p of byPitch.get(c.midi - 12) ?? []) {
      if (p.n === c || Math.abs(p.n.start - c.start) > window) continue;
      const r = mean(c) / Math.max(1e-6, mean(p.n));
      if (r < ratio && (!best || r < best.r)) best = { ...p, r };
    }
    if (best) out.set(c, best.cand ? best.n : undefined);
  }
  return out;
}

/**
 * `base` with its notes split where a candidate re-strikes them (LeadRecoveryRule.restrike*): the
 * main note ends 5 ms before the candidate's start and a new main note of the same pitch runs from
 * there to the old end. Notes that are not split are the same objects.
 */
export function splitRestrikes(
  base: Note[],
  candidates: Note[],
  rule: LeadRecoveryRule,
  evidence: (n: Note) => LeadEvidence,
  exclude?: [number, number][],
  only?: Set<number>,
): Note[] {
  const byPitch = new Map<number, Note[]>();
  for (const c of candidates) {
    if (c.midi < rule.minMidi || c.midi > rule.maxMidi || inRanges(exclude, c.start)) continue;
    let a = byPitch.get(c.midi);
    if (!a) byPitch.set(c.midi, (a = []));
    a.push(c);
  }
  if (!byPitch.size) return base;
  const out: Note[] = [];
  let changed = false;
  for (const b of base) {
    const cs = byPitch.get(b.midi);
    if (!cs || (only && !only.has(b.id))) {
      out.push(b);
      continue;
    }
    let cur = b;
    for (const c of sortNotes(cs)) {
      const end = cur.start + cur.dur;
      if (c.start < cur.start + rule.restrikeAfter || c.start > end - rule.minDur) continue;
      const e = evidence(c);
      if ((e.onset ?? 0) < rule.restrikeOnset || (e.rise ?? 0) < rule.restrikeRise) continue;
      out.push({ ...cur, dur: c.start - 0.005 - cur.start });
      cur = { ...cur, id: newNoteId(), start: c.start, dur: end - c.start };
      changed = true;
    }
    out.push(cur);
  }
  return changed ? sortNotes(out) : base;
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
  const notes = recoverFromCandidates(base, candidates, duration, opts);
  return opts.extra?.length ? addExtraLead(notes, opts.extra, opts) : notes;
}

/**
 * `notes` (main + recovered) plus the `extra` lead notes (LeadRecoveryOptions.extra) not already
 * there, tagged as recovered notes are; the same objects when none is added.
 */
export function addExtraLead(notes: Note[], extra: Note[], opts: Pick<LeadRecoveryOptions, 'rule' | 'exclude' | 'hardOnly' | 'doublesHardOnly'> = {}): Note[] {
  const rule = { ...LEAD_RECOVERY, ...opts.rule };
  const fresh = freshCandidates(notes, extra.filter((c) => !inRanges(opts.exclude, c.start)), rule);
  if (!fresh.length) return notes;
  const tagged = opts.hardOnly
    ? fresh.map((n) => ({ ...n, role: 'lead' as const }))
    : opts.doublesHardOnly
      ? fresh.map((n) => (doublesMainNote(n, notes) ? { ...n, role: 'lead' as const } : n))
      : fresh;
  return sortNotes([...notes, ...tagged]);
}

function recoverFromCandidates(base: Note[], candidates: Note[], duration: number, opts: LeadRecoveryOptions): Note[] {
  const rule = { ...LEAD_RECOVERY, ...opts.rule };
  const ev = new Map<number, LeadEvidence>();
  const meanOf = (n: Note) => {
    let e = ev.get(n.id);
    if (!e && opts.evidence) ev.set(n.id, (e = opts.evidence(n)));
    return e?.mean ?? n.vel;
  };
  // the evidence test comes before the tune line: a weak candidate (often an overtone an octave
  // above the lead) that the line would go through and the test then removes leaves a hole where
  // the line would otherwise have taken the real lead note
  const fresh = freshCandidates(base, candidates, rule).filter((c) => {
    if (inRanges(opts.exclude, c.start)) return false;
    if (!opts.evidence) return true;
    const e = opts.evidence(c);
    ev.set(c.id, e);
    const minMean = e.onset !== undefined && e.onset >= rule.strongOnset ? Math.min(rule.minMean, rule.strongMinMean) : rule.minMean;
    return e.mean >= minMean && e.spread < rule.maxSpread && (e.onset === undefined || e.onset >= rule.minOnset);
  });
  const splits = !!opts.evidence && rule.restrikeOnset <= 1;
  if (!fresh.length && !splits) return base;
  const freshIds = new Set(fresh.map((n) => n.id));
  const all = assignHands(sortNotes([...base, ...fresh]), duration);
  const line = instrumentLine(tuneCandidates(all));
  // repeated tune notes the main pass ran through: only main notes the line goes through are split
  // (a re-attack inside a chord tone or a held accompaniment note is not the tune)
  if (splits) {
    const lineMain = new Set(line.filter((n) => !freshIds.has(n.id)).map((n) => n.id));
    base = splitRestrikes(base, candidates, rule, opts.evidence!, opts.exclude, lineMain);
  }
  if (!fresh.length) return base;
  const onLine = new Set(line.filter((n) => freshIds.has(n.id)).map((n) => n.id));
  let picked = fresh.filter((c) => onLine.has(c.id));
  // after the line (removing them before re-routes it and loses lead notes elsewhere): the main note
  // an octave below already carries the tune there
  if (rule.overtoneRatio > 0 && opts.evidence && picked.length) {
    const overtones = overtoneCandidates(base, picked, rule.overtoneRatio, meanOf);
    if (overtones.size) picked = picked.filter((c) => !overtones.has(c));
  }
  // an octave-above shadow of a note attacked with it: dropped, or replaced by the lower candidate
  if (rule.octaveAttackRatio > 0 && opts.evidence && picked.length) {
    const pickedSet = new Set(picked);
    const shadows = octaveAttacks(picked, rule.octaveAttackMain ? base : [], fresh.filter((c) => !pickedSet.has(c)), rule.octaveAttackRatio, rule.octaveAttackWindow, meanOf);
    if (shadows.size) {
      const next: Note[] = [];
      for (const c of picked) {
        if (!shadows.has(c)) next.push(c);
        else {
          const low = shadows.get(c);
          if (low && !pickedSet.has(low)) {
            next.push(low);
            pickedSet.add(low);
          }
        }
      }
      picked = sortNotes(next);
    }
  }
  let kept = capDensity(picked, meanOf, rule);
  if (opts.hardOnly) kept = kept.map((n) => ({ ...n, role: 'lead' as const }));
  else if (opts.doublesHardOnly) kept = kept.map((n) => (doublesMainNote(n, base) ? { ...n, role: 'lead' as const } : n));
  return kept.length ? sortNotes([...base, ...kept]) : base;
}
