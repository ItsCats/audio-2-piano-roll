/**
 * Pitch track of the lead-bearing stem (separated "other" stem, plus the vocal stem where it goes
 * back into the accompaniment) as an independent cue for the instruments' tune.
 *
 * Basic Pitch's posteriors alone cannot tell which of two simultaneous pitches is the lead, nor in
 * which octave the lead sits when its octave neighbour is lit too. CREPE-tiny (lib/pitch, already
 * shipped) follows the most prominent single pitch of the stem; where it agrees with a note, that
 * note is more likely the tune. It is a cue, never a gate: on a stem with loud comping it follows
 * the comping.
 *
 * Pure: the pipeline runs the tracker (transcription/pipeline.ts) and stores the track with the
 * posteriors (StoredPosteriors.leadPitch) so that re-detection sees the same cue.
 */
import type { Note } from '../music/types';

/** The stored form: per frame of `hop` s, the pitch as MIDI (fractional, 0 = none) and CREPE's confidence 0..1 (8-bit). */
export interface StoredPitch {
  hop: number;
  midi: Float32Array;
  conf: Uint8Array;
  /** frame loudness of the stem, dB re its 95th-percentile frame (8-bit: 255 + dB, so 0 dB = 255 and −255 dB = 0) */
  level: Uint8Array;
}

export interface PitchCueRule {
  /** frames whose confidence is below this carry no pitch */
  minConf: number;
  /** ...nor frames more than this many dB below the stem's 95th-percentile loudness */
  minLevelDb: number;
  /** a frame agrees with a note when its pitch is within this many semitones of it */
  tolerance: number;
  /** the part of a note that is compared: from its start to at most this many seconds in */
  window: number;
  /** ...starting this many seconds in (the attack of a plucked / blown note has no clear pitch yet) */
  skip: number;
}

export const PITCH_CUE: PitchCueRule = { minConf: 0.5, minLevelDb: -30, tolerance: 0.6, window: 0.35, skip: 0.02 };

/** A pitch track (lib/pitch trackVocalPitchDetailed: raw f0 in Hz, periodicity, frame RMS) in its stored form. */
export function storedPitch(t: { f0: Float32Array; periodicity: Float32Array; rms: Float32Array; hop: number }): StoredPitch {
  const n = Math.min(t.f0.length, t.periodicity.length, t.rms.length);
  const sorted = Array.from(t.rms.subarray(0, n)).filter((v) => v > 1e-7).sort((a, b) => a - b);
  const ref = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 1;
  const midi = new Float32Array(n);
  const conf = new Uint8Array(n);
  const level = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hz = t.f0[i];
    midi[i] = hz > 0 ? 69 + 12 * Math.log2(hz / 440) : 0;
    conf[i] = Math.round(Math.max(0, Math.min(1, t.periodicity[i])) * 255);
    const db = t.rms[i] > 1e-9 ? 20 * Math.log10(t.rms[i] / ref) : -255;
    level[i] = Math.max(0, Math.min(255, Math.round(255 + db)));
  }
  return { hop: t.hop, midi, conf, level };
}

/** Pitch (MIDI, fractional) of frame i when it carries one, else 0. */
export function framePitch(p: StoredPitch, i: number, rule: PitchCueRule = PITCH_CUE): number {
  if (i < 0 || i >= p.midi.length) return 0;
  if (p.conf[i] < rule.minConf * 255 || p.level[i] - 255 < rule.minLevelDb) return 0;
  return p.midi[i];
}

export interface PitchSupport {
  /** frames in the note's window that carry a pitch */
  voiced: number;
  /** shares of those frames at the note's pitch, an octave above, an octave below, at its pitch class (any octave) */
  exact: number;
  up: number;
  down: number;
  pc: number;
  /** frames in the window */
  frames: number;
}

/** How the stem's pitch track agrees with `midi` over [t0, t1] (s). */
export function pitchSupport(p: StoredPitch, midi: number, t0: number, t1: number, rule: PitchCueRule = PITCH_CUE): PitchSupport {
  const a = Math.max(0, Math.round(t0 / p.hop));
  const b = Math.min(p.midi.length - 1, Math.round(t1 / p.hop));
  let voiced = 0;
  let exact = 0;
  let up = 0;
  let down = 0;
  let pc = 0;
  for (let i = a; i <= b; i++) {
    const m = framePitch(p, i, rule);
    if (!m) continue;
    voiced++;
    const d = m - midi;
    if (Math.abs((((d % 12) + 18) % 12) - 6) <= rule.tolerance) pc++;
    if (Math.abs(d) <= rule.tolerance) exact++;
    else if (Math.abs(d - 12) <= rule.tolerance) up++;
    else if (Math.abs(d + 12) <= rule.tolerance) down++;
  }
  const v = Math.max(1, voiced);
  return { voiced, exact: exact / v, up: up / v, down: down / v, pc: pc / v, frames: Math.max(0, b - a + 1) };
}

/** pitchSupport over a note's opening window (PitchCueRule skip / window). */
export function noteSupport(p: StoredPitch, n: Note, rule: PitchCueRule = PITCH_CUE): PitchSupport {
  const t0 = n.start + Math.min(rule.skip, n.dur / 2);
  return pitchSupport(p, n.midi, t0, n.start + Math.max(Math.min(rule.window, n.dur), rule.skip + 0.03), rule);
}

export interface TuneCueRule {
  /** notes from this pitch up are tagged (the tune's register) */
  minMidi: number;
  /** a note is tagged only when at least this share of its window carries a pitch (and 3 frames) */
  minVoiced: number;
  /** agreement at the note's pitch class (any octave) instead of its exact pitch */
  pitchClass: boolean;
}

export const TUNE_CUE: TuneCueRule = { minMidi: 55, minVoiced: 0.4, pitchClass: true };

/** `notes` with Note.tune set from the stem's pitch track (see Note.tune); untagged notes are the same objects. */
export function tagTune(notes: Note[], p: StoredPitch, rule: TuneCueRule = TUNE_CUE, cue: PitchCueRule = PITCH_CUE): Note[] {
  return notes.map((n) => {
    if (n.midi < rule.minMidi) return n;
    const s = noteSupport(p, n, cue);
    if (s.voiced < 3 || s.voiced < rule.minVoiced * s.frames) return n.tune === undefined ? n : { ...n, tune: undefined };
    return { ...n, tune: Math.round((rule.pitchClass ? s.pc : s.exact) * 100) / 100 };
  });
}

export interface OctaveRule {
  /** a note moves when at least this share of its voiced window is an octave away and at most `maxExact` at its own pitch */
  minShare: number;
  maxExact: number;
  /** tune-line notes further apart than this (s) start a new phrase */
  phraseGap: number;
  /** a note with fewer voiced frames follows its phrase: the phrase's octave-away weight must be this many times its own-pitch weight */
  phraseRatio: number;
  weakFrames: number;
}

export const LINE_OCTAVE: OctaveRule = { minShare: 0.5, maxExact: 0.15, phraseGap: 0.5, phraseRatio: 3, weakFrames: 4 };

/**
 * Tune-line notes the stem's pitch track hears an octave away (an octave slip of the many-notes
 * detector): moved by an octave, decided per note where the track is clear and per phrase (line
 * notes closer than `phraseGap`) where it is not. A note is not moved onto a pitch another note
 * already plays at that time (the tune line can take that note instead). Returns `notes` with the
 * moved notes replaced (same ids).
 */
export function fixLineOctaves(notes: Note[], lineIds: Set<number>, p: StoredPitch, rule: OctaveRule = LINE_OCTAVE, cue: PitchCueRule = PITCH_CUE): Note[] {
  const line = notes.filter((n) => lineIds.has(n.id)).sort((a, b) => a.start - b.start);
  if (!line.length) return notes;
  const sup = new Map(line.map((n) => [n.id, noteSupport(p, n, cue)]));
  const shift = new Map<number, number>();
  let i = 0;
  while (i < line.length) {
    let j = i;
    while (j + 1 < line.length && line[j + 1].start - (line[j].start + line[j].dur) <= rule.phraseGap) j++;
    let ex = 0;
    let up = 0;
    let down = 0;
    for (let k = i; k <= j; k++) {
      const s = sup.get(line[k].id)!;
      ex += s.exact * s.voiced;
      up += s.up * s.voiced;
      down += s.down * s.voiced;
    }
    const phrase = up > rule.phraseRatio * ex && up > down ? 12 : down > rule.phraseRatio * ex && down > up ? -12 : 0;
    for (let k = i; k <= j; k++) {
      const n = line[k];
      const s = sup.get(n.id)!;
      let d = 0;
      if (s.voiced >= rule.weakFrames) {
        if (s.exact <= rule.maxExact && s.up >= rule.minShare) d = 12;
        else if (s.exact <= rule.maxExact && s.down >= rule.minShare) d = -12;
      } else if (s.exact * s.voiced < 1) d = phrase;
      if (d && n.midi + d >= 21 && n.midi + d <= 108) shift.set(n.id, d);
    }
    i = j + 1;
  }
  if (!shift.size) return notes;
  const busy = (n: Note, midi: number) =>
    notes.some((m) => m.id !== n.id && m.midi === midi && m.start < n.start + n.dur - 0.03 && m.start + m.dur > n.start + 0.03);
  return notes.map((n) => {
    const d = shift.get(n.id);
    if (!d || busy(n, n.midi + d)) return n;
    const moved = { ...n, midi: n.midi + d };
    const s = noteSupport(p, moved, cue);
    return { ...moved, tune: Math.round(s.exact * 100) / 100 };
  });
}

export interface AboveRule {
  /** 'off', or what happens to a note above a confirmed tune note: dropped, or moved down by octaves below it */
  mode: 'off' | 'drop' | 'lower';
  /** the tune note's own support (Note.tune) at least this */
  minTune: number;
  /** the note above: its support at most this (the stem hears the tune, not it) */
  maxTune: number;
  /** ...starting within this many seconds of the tune note's start */
  window: number;
  /** only notes an octave (or two) above the tune note (its doubling / overtone) */
  octaveOnly: boolean;
}

export const ABOVE_TUNE: AboveRule = { mode: 'off', minTune: 0.5, maxTune: 0.1, window: 0.06, octaveOnly: true };

/**
 * Notes struck with a tune-line note the stem's pitch track confirms (Note.tune >= minTune), above
 * it, that the track does not hear (Note.tune <= maxTune): backing in the tune's register or the
 * tune doubled an octave up, which would otherwise be the top note of the right hand. Dropped or
 * moved below the tune note (AboveRule.mode); notes without the cue are never touched.
 */
export function clearAboveTune(notes: Note[], lineIds: Set<number>, rule: AboveRule = ABOVE_TUNE): Note[] {
  if (rule.mode === 'off' || !lineIds.size) return notes;
  const line = notes.filter((n) => lineIds.has(n.id) && (n.tune ?? 0) >= rule.minTune).sort((a, b) => a.start - b.start);
  if (!line.length) return notes;
  const starts = line.map((n) => n.start);
  const drop = new Set<number>();
  const lower = new Map<number, number>();
  for (const x of notes) {
    if (lineIds.has(x.id) || x.tune === undefined || x.tune > rule.maxTune) continue;
    // tune notes struck with x
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < x.start - rule.window) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < line.length && line[i].start <= x.start + rule.window; i++) {
      const l = line[i];
      const d = x.midi - l.midi;
      if (d <= 0 || (rule.octaveOnly && d % 12 !== 0)) continue;
      if (rule.mode === 'drop') drop.add(x.id);
      else {
        let m = x.midi - 12 * Math.ceil(d / 12);
        if (m === l.midi) m -= 12;
        if (m >= 21) lower.set(x.id, m);
        else drop.add(x.id);
      }
      break;
    }
  }
  if (!drop.size && !lower.size) return notes;
  return notes.filter((n) => !drop.has(n.id)).map((n) => (lower.has(n.id) ? { ...n, midi: lower.get(n.id)!, tune: undefined } : n));
}

/**
 * The pitch track over a gap [t0, t1] (s) between two tune notes, against pitch `midi`: frames with
 * a clear pitch, those at midi's pitch class (any octave: CREPE-tiny on a mixed stem often reports
 * the octave below), and the level fall (dB) from the 0.1 s before t0 to the gap's quietest frame.
 * The gap-closing test of music/sustain.ts (SustainRule.closeGap).
 */
export function gapCue(p: StoredPitch, midi: number, t0: number, t1: number, rule: PitchCueRule = PITCH_CUE): { voiced: number; agree: number; dropDb: number } {
  const a = Math.max(0, Math.round(t0 / p.hop));
  const b = Math.min(p.midi.length - 1, Math.round(t1 / p.hop));
  let voiced = 0;
  let agree = 0;
  let inGap = 255;
  for (let i = a; i <= b; i++) {
    inGap = Math.min(inGap, p.level[i]);
    const m = framePitch(p, i, rule);
    if (!m) continue;
    voiced++;
    const d = (((m - midi) % 12) + 18) % 12 - 6;
    if (Math.abs(d) <= rule.tolerance) agree++;
  }
  let before = 0;
  for (let i = Math.max(0, a - Math.round(0.1 / p.hop)); i <= Math.min(a, p.level.length - 1); i++) before = Math.max(before, p.level[i]);
  return { voiced, agree, dropDb: b >= a ? before - inGap : 0 };
}

export interface HoldCueRule {
  /** 'off' disables the held-by-pitch-track extension */
  on: boolean;
  /** the hold ends at the first run of this many seconds of frames at another pitch class */
  stopAfter: number;
  /** ...or of frames without a clear pitch */
  maxSilent: number;
  /** ...or at the first frame more than this many dB below the stem's loudest frame in the note's last 0.1 s (the note fades or the phrase ends) */
  maxDropDb: number;
}

export const HOLD_CUE: HoldCueRule = { on: true, stopAfter: 0.03, maxSilent: 0.08, maxDropDb: 12 };

/**
 * End (s) of note `n` held while the stem's pitch track stays at its pitch class (any octave), at
 * most `limit`: from the note's end, frames at its pitch class extend it; a run of `stopAfter` s at
 * another pitch class, or `maxSilent` s without a clear pitch, ends it (at the last agreeing frame).
 * A sustained lead note under louder backing fades out of Basic Pitch's frame posteriors long before
 * it ends; the pitch track of its stem often still follows it. Returns n's end when not held.
 */
export function pitchHeldEnd(p: StoredPitch, n: Note, limit: number, rule: HoldCueRule = HOLD_CUE, cue: PitchCueRule = PITCH_CUE): number {
  const end = n.start + n.dur;
  if (!rule.on || limit <= end) return end;
  const a = Math.max(0, Math.round(end / p.hop));
  const b = Math.min(p.midi.length - 1, Math.floor(limit / p.hop));
  const stop = Math.max(1, Math.round(rule.stopAfter / p.hop));
  const silent = Math.max(1, Math.round(rule.maxSilent / p.hop));
  let top = 0;
  for (let i = Math.max(0, a - Math.round(0.1 / p.hop)); i <= Math.min(a, p.level.length - 1); i++) top = Math.max(top, p.level[i]);
  let last = -1;
  let off = 0;
  let quiet = 0;
  for (let i = a; i <= b; i++) {
    if (top - p.level[i] > rule.maxDropDb) break;
    const m = framePitch(p, i, cue);
    if (!m) {
      if (++quiet >= silent) break;
      continue;
    }
    quiet = 0;
    const d = Math.abs(((((m - n.midi) % 12) + 18) % 12) - 6);
    if (d <= cue.tolerance) {
      last = i;
      off = 0;
    } else if (++off >= stop) break;
  }
  return last < 0 ? end : Math.min(limit, Math.max(end, (last + 1) * p.hop));
}

/**
 * Whether the pitch track stays at `midi`'s pitch class over [t, t + window] (most of its frames with
 * a clear pitch, at least `minFrames`) when a note of pitch `struck` starts at t: not when the track
 * is at `struck` itself (an octave below a held note has the held note's pitch class too: then the
 * tune stepped down onto the struck note).
 */
export function pitchContinues(p: StoredPitch, midi: number, t: number, struck?: number, window = 0.12, minFrames = 5, cue: PitchCueRule = PITCH_CUE): boolean {
  const c = gapCue(p, midi, t, t + window, cue);
  if (!(c.voiced >= minFrames && c.agree >= 0.7 * c.voiced)) return false;
  if (struck === undefined || (struck - midi) % 12 !== 0) return true;
  const s = pitchSupport(p, struck, t, t + window, cue);
  return s.exact < 0.5;
}
