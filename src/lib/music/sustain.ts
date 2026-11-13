/**
 * Held tune notes for the "Full song" preset: the notes of the instruments' tune line keep sounding
 * while the model still hears their pitch, instead of ending where the frame posterior first dips
 * under the detection threshold.
 *
 * Why: a sustained lead (synth, strings, flute) under a louder accompaniment drops below the "Full
 * song" frame threshold (0.35) in the middle of a long note, so Basic Pitch ends the note there and
 * the tune sounds choppy: on band-instrumental-1 (estimated lead reference, no human transcription)
 * Hard released held lead notes (0.4 s or longer) at a median 63 % of their length, the median gap
 * between consecutive lead notes was 58 ms where the lead itself is legato (10-20 ms), and at a
 * held phrase-end note (0:57-0:59) the tune dropped to an inner harmony note for 0.8 s.
 *
 * How: on a copy of the notes, every right-hand note from `minMidi` up is held while its pitch's
 * frame posterior (5-frame median) stays at `low` or above (a two-threshold continuation, as in
 * Basic Pitch's own note tracking with a lower "off" threshold), up to `maxExtend` s more, and never
 * past the next note of the same pitch, a new attack of its pitch, or a clear new note a little
 * below it (the tune stepping down while the old note rings on). The tune line (melody.ts
 * instrumentLine, as Easy and Medium use) is chosen on that copy, and only the notes it goes through
 * get their longer ending, capped at the start of the next line note. The line is the one through
 * all notes, Hard-only recovered notes included (as Hard plays it): a main note Easy and Medium use
 * as their tune note is not held where Hard's line goes through a recovered note instead, a held
 * main note stops where a recovered note starts, and folding can lengthen a main note across a
 * recovered one. Extending every right-hand
 * note was measured and is worse: held chord tops and repeated accompaniment notes then sit over
 * the tune (band-instrumental-1 Hard R_top 50 -> 43 %).
 *
 * Pure: the pipeline (transcription/pipeline.ts accompFromRaw) supplies the posterior scan.
 */
import type { Note } from './types';
import { assignHands } from './hands';
import { instrumentLine, tuneCandidates } from './melody';
import { sortNotes } from './cleanup';

export interface SustainRule {
  /** lowest pitch that is held (the tune's register) */
  minMidi: number;
  /** a note is held at most this many seconds past its detected end */
  maxExtend: number;
  /** a new note at most this many semitones below with an onset at least `stopOnset` ends the hold */
  stopBelow: number;
  stopOnset: number;
  /** gap (s) left before the next same-pitch note / the next line note */
  gap: number;
  /**
   * a line note that follows a same-pitch line note within `joinGap` s (after holding) and whose
   * frame activation rises by less than this at its start is the same held note (the model's onset
   * head fires on vibrato and tremolo): it is folded into the note before. 0: no folding
   */
  joinRise: number;
  joinGap: number;
  /**
   * gap closing (separated songs, SustainOptions.gapCue): a tune-line note followed by the next line
   * note within `closeGap` s is held up to it unless the lead-bearing stem's pitch track hears
   * another pitch class in the gap (of its frames with a clear pitch, at least `closeMinVoiced`, less
   * than `closeMinAgree` at the note's pitch class: the tune moved on or the gap is a rest the backing
   * fills), the stem's level falls more than `closeDropDb` dB in the gap (silence), or the note's
   * pitch is struck again in between. 0: off
   */
  closeGap: number;
  closeMinAgree: number;
  closeMinVoiced: number;
  closeDropDb: number;
}

export const SUSTAIN: SustainRule = {
  minMidi: 60,
  maxExtend: 2.5,
  stopBelow: 12,
  stopOnset: 0.5,
  gap: 0.01,
  joinRise: 0.1,
  joinGap: 0.03,
  closeGap: 0.25,
  closeMinAgree: 0.3,
  closeMinVoiced: 2,
  closeDropDb: 12,
};

export interface SustainOptions {
  rule?: Partial<SustainRule>;
  /**
   * End (s) of note `n` held while the model still hears its pitch, at most `limit`; the pipeline
   * scans the frame posteriors (transcription/pipeline.ts heldEnd). Returns n's end when it is not held.
   */
  heldEnd: (n: Note, limit: number) => number;
  /** onset strength of a note (pipeline onsetPeak): the step-down stop test; without it no such stop */
  onset?: (n: Note) => number;
  /** frame-activation rise at a note's start (pipeline frameRise): the re-strike test; without it nothing is folded */
  rise?: (n: Note) => number;
  /**
   * The lead-bearing stem's pitch track over [t0, t1] (s) against pitch `midi` (transcription/
   * stemPitch.ts gapCue): frames with a clear pitch, those at midi's pitch class, and how far (dB) its
   * level falls from the 0.1 s before t0 to the quietest frame in the gap. Without it no gap is closed.
   */
  gapCue?: (midi: number, t0: number, t1: number) => { voiced: number; agree: number; dropDb: number };
  /**
   * Whether the lead-bearing stem's pitch track stays with held note n when note x is struck below
   * it (x is then backing, not the tune stepping down): without it every such note ends the hold.
   */
  continues?: (n: Note, x: Note) => boolean;
}

/** `notes` with the tune line's notes held (see the module comment); other notes are the same objects. */
export function sustainTuneLine(notes: Note[], duration: number, opts: SustainOptions): Note[] {
  const rule = { ...SUSTAIN, ...opts.rule };
  if (!notes.length) return notes;
  const sorted = sortNotes(notes);
  const handed = assignHands(sorted, duration);
  const hand = new Map(handed.map((n) => [n.id, n.hand]));
  const byPitch = new Map<number, Note[]>();
  for (const n of sorted) {
    let a = byPitch.get(n.midi);
    if (!a) byPitch.set(n.midi, (a = []));
    a.push(n);
  }
  // clear new right-hand notes (the step-down stop), time-sorted
  const strong = opts.onset ? sorted.filter((n) => hand.get(n.id) === 'R' && opts.onset!(n) >= rule.stopOnset) : [];
  const strongStarts = strong.map((n) => n.start);
  const firstFrom = (t: number) => {
    let lo = 0;
    let hi = strongStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strongStarts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const ext = new Map<number, number>();
  for (const [midi, arr] of byPitch) {
    if (midi < rule.minMidi) continue;
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (hand.get(n.id) !== 'R') continue;
      const end = n.start + n.dur;
      let limit = Math.min(duration, end + rule.maxExtend, i + 1 < arr.length ? arr[i + 1].start - rule.gap : Infinity);
      if (rule.stopBelow > 0) {
        for (let k = firstFrom(end - 0.03); k < strong.length; k++) {
          const x = strong[k];
          if (x.start >= limit) break;
          // (not when the stem's pitch track stays at the held note's pitch class past it: backing)
          if (x.midi < midi && x.midi >= midi - rule.stopBelow && !opts.continues?.(n, x)) {
            limit = x.start - rule.gap;
            break;
          }
        }
      }
      if (limit <= end) continue;
      const e = Math.min(limit, opts.heldEnd(n, limit));
      if (e > end + 0.005) ext.set(n.id, e);
    }
  }
  if (!ext.size && !opts.rise && !(opts.gapCue && rule.closeGap > 0)) return notes;
  // the tune line through the held copy
  const copy = handed.map((n) => (ext.has(n.id) ? { ...n, dur: ext.get(n.id)! - n.start } : n));
  const line = instrumentLine(tuneCandidates(copy));
  const byId = new Map(sorted.map((n) => [n.id, n]));
  const newEnd = new Map<number, number>();
  for (let i = 0; i < line.length; i++) {
    const e = ext.get(line[i].id);
    if (e === undefined) continue;
    const cap = i + 1 < line.length ? line[i + 1].start - rule.gap : e;
    const orig = byId.get(line[i].id);
    if (orig && Math.min(e, cap) > orig.start + orig.dur + 0.005) newEnd.set(orig.id, Math.min(e, cap));
  }
  // same-pitch line notes without a new attack: one held note. A recovered (Hard-only) note can be
  // folded into a main note but not the other way round, so Easy and Medium keep their notes.
  const drop = new Set<number>();
  if (opts.rise && rule.joinRise > 0) {
    const endOf = (n: Note) => newEnd.get(n.id) ?? n.start + n.dur;
    let a: Note | undefined;
    for (const l of line) {
      const b = byId.get(l.id);
      if (!b) continue;
      if (
        a &&
        b.midi === a.midi &&
        b.start - endOf(a) <= rule.joinGap &&
        !(a.role === 'lead' && b.role !== 'lead') &&
        opts.rise(b) < rule.joinRise
      ) {
        newEnd.set(a.id, Math.max(endOf(a), endOf(b)));
        drop.add(b.id);
        continue;
      }
      a = b;
    }
  }
  // short gaps inside a phrase: the note is held up to the next line note (see closeGap)
  if (opts.gapCue && rule.closeGap > 0) {
    const endOf = (n: Note) => newEnd.get(n.id) ?? n.start + n.dur;
    const lineNotes = line.map((l) => byId.get(l.id)).filter((n): n is Note => !!n && !drop.has(n.id));
    for (let i = 0; i + 1 < lineNotes.length; i++) {
      const a = lineNotes[i];
      const b = lineNotes[i + 1];
      const end = endOf(a);
      const gap = b.start - end;
      if (gap <= rule.gap + 0.005 || gap > rule.closeGap || a.midi < rule.minMidi) continue;
      const same = byPitch.get(a.midi) ?? [];
      if (same.some((x) => x !== a && x.start > a.start && x.start < b.start)) continue;
      const cue = opts.gapCue(a.midi, end, b.start);
      if (cue.dropDb > rule.closeDropDb) continue;
      if (cue.voiced >= rule.closeMinVoiced && cue.agree < rule.closeMinAgree * cue.voiced) continue;
      newEnd.set(a.id, b.start - rule.gap);
    }
  }
  if (!newEnd.size && !drop.size) return notes;
  return notes.filter((n) => !drop.has(n.id)).map((n) => (newEnd.has(n.id) ? { ...n, dur: newEnd.get(n.id)! - n.start } : n));
}
