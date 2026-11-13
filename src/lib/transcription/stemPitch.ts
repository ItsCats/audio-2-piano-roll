/**
 * Pitch track of the lead-bearing stem (separated "other" stem, plus the vocal stem where it goes
 * back into the accompaniment) as an independent cue for the instruments' tune.
 *
 * Basic Pitch's posteriors alone cannot tell which of two simultaneous pitches is the lead, nor in
 * which octave the lead sits when its octave neighbour is lit too. CREPE-tiny (lib/pitch, already
 * shipped) follows the most prominent single pitch of the stem; where it agrees with a note, that
 * note is more likely the tune. It is a cue, never a gate: on a stem with loud comping it follows
 * the comping. On the Slakh band set it did not tell the lead from the comping (tagging notes with
 * it, using it as a bonus in the tune-line search or moving octave slips by it were tried and did
 * not hold up), so it is used only to hold the tune line's notes and close short gaps in it
 * (music/sustain.ts).
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
  /**
   * frames at the note's pitch class but in another octave than the track was at during the note
   * count as another pitch (the tune moving by an octave, e.g. G4 -> G3, is not the G4 still held)
   */
  sameOctave: boolean;
}

export const HOLD_CUE: HoldCueRule = { on: true, stopAfter: 0.03, maxSilent: 0.08, maxDropDb: 12, sameOctave: true };

/** The octave offset (multiple of 12 from `midi`, rounded) the track's frames at midi's pitch class mostly have over frames [a, b]; undefined without any. */
function trackOctave(p: StoredPitch, midi: number, a: number, b: number, cue: PitchCueRule): number | undefined {
  const count = new Map<number, number>();
  for (let i = Math.max(0, a); i <= Math.min(b, p.midi.length - 1); i++) {
    const m = framePitch(p, i, cue);
    if (!m) continue;
    const d = m - midi;
    if (Math.abs((((d % 12) + 18) % 12) - 6) > cue.tolerance) continue;
    const k = Math.round(d / 12);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [k, c] of count) if (best === undefined || c > count.get(best)!) best = k;
  return best;
}

/**
 * End (s) of note `n` held while the stem's pitch track stays at its pitch class (in the octave the
 * track was at during the note: CREPE-tiny is often an octave off), at most `limit`: from the note's
 * end, such frames extend it; a run of `stopAfter` s at another pitch (or octave), or `maxSilent` s
 * without a clear pitch, ends it (at the last agreeing frame).
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
  // the track's octave during the note (CREPE-tiny is often an octave off; a change of octave is a move)
  let oct = rule.sameOctave ? trackOctave(p, n.midi, Math.round((n.start + Math.min(cue.skip, n.dur / 2)) / p.hop), a, cue) : undefined;
  for (let i = a; i <= b; i++) {
    if (top - p.level[i] > rule.maxDropDb) break;
    const m = framePitch(p, i, cue);
    if (!m) {
      if (++quiet >= silent) break;
      continue;
    }
    quiet = 0;
    const d = Math.abs(((((m - n.midi) % 12) + 18) % 12) - 6);
    const k = Math.round((m - n.midi) / 12);
    if (d <= cue.tolerance && rule.sameOctave && oct === undefined) oct = k;
    if (d <= cue.tolerance && (oct === undefined || k === oct)) {
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
