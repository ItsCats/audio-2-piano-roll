/**
 * Practice scoring: compares incoming notes (MIDI keyboard or computer keyboard) with the
 * expected notes of the arrangement.
 *  - correct: right pitch within ±window of an expected, unmatched note onset
 *  - wrong:   a key press matching no expected note in the window
 *  - missed:  an expected note whose window passed without a matching press
 *
 * Practice is scored in passes: every time song time jumps backwards (A-B loop wrap, seek back,
 * back to start) a new pass starts and the notes of the section can be played (and missed)
 * again. A forward seek skips the notes in between without counting them as missed.
 */
import type { Hand, Note } from '../music/types';

export interface PracticeStats {
  correct: number;
  wrong: number;
  missed: number;
  total: number; // expected notes passed so far
  meanAbsTimingMs: number;
  meanSignedTimingMs: number; // + late, - early
  accuracy: number; // 0..100
  streak: number;
  bestStreak: number;
  /** 1 for the first pass; +1 at each loop wrap / seek back after notes were played or missed */
  pass: number;
  /** best accuracy of the earlier passes in this session (null before the second pass) */
  bestAccuracy: number | null;
}

/** Song time moving more than this far against the clock counts as a jump (seek / loop wrap). */
export const JUMP_TOLERANCE_SEC = 0.25;

/**
 * Follows song time between scorer updates and tells a real jump from normal playback.
 * Uses a high-water mark, so a seek back that happens in small steps (dragging the roll) is
 * still seen once it adds up, and the short pre-roll after a seek or a released hold is not.
 */
export class TimeJumpDetector {
  private hw: number | null = null;
  /** furthest song time seen since the last jump */
  get high(): number | null {
    return this.hw;
  }
  reset(t: number | null = null): void {
    this.hw = t;
  }
  /**
   * `advance`: how far song time may have moved since the last call during normal playback
   * (wall-clock seconds × rate; 0 while paused).
   */
  check(t: number, advance = 0): 'back' | 'forward' | null {
    if (this.hw === null) {
      this.hw = t;
      return null;
    }
    if (t < this.hw - JUMP_TOLERANCE_SEC) {
      this.hw = t;
      return 'back';
    }
    const jumpedForward = t > this.hw + Math.max(0, advance) + JUMP_TOLERANCE_SEC;
    this.hw = Math.max(this.hw, t);
    return jumpedForward ? 'forward' : null;
  }
}

export class PracticeScorer {
  private notes: Note[];
  private matched = new Set<number>();
  private missedSet = new Set<number>();
  private idx = 0; // first not-yet-expired expected note
  private timing: number[] = [];
  private wrong = 0;
  private streak = 0;
  private bestStreak = 0;
  private pass = 1;
  private passAccuracies: number[] = [];
  windowSec: number;

  constructor(notes: Note[], hands: Record<Hand, boolean>, windowMs = 150) {
    this.notes = notes.filter((n) => hands[n.hand]).sort((a, b) => a.start - b.start);
    this.windowSec = windowMs / 1000;
  }

  /** Start over: score, streaks and earlier passes are cleared. */
  reset(from: number): void {
    this.clearPass(from);
    this.bestStreak = 0;
    this.pass = 1;
    this.passAccuracies = [];
  }

  private clearPass(from: number): void {
    this.matched.clear();
    this.missedSet.clear();
    this.timing = [];
    this.wrong = 0;
    this.streak = 0;
    this.seek(from);
  }

  private seek(from: number): void {
    this.idx = this.notes.findIndex((n) => n.start >= from - this.windowSec);
    if (this.idx < 0) this.idx = this.notes.length;
  }

  /**
   * Song time jumped back (loop wrap or seek): close the current pass and score the section
   * again from `from`. `endedAt` is where playback was before the jump: expected notes up to
   * there that were not played count as missed in the pass that just ended. A pass in which
   * nothing was played or missed is not counted.
   */
  newPass(from: number, endedAt?: number): void {
    if (endedAt !== undefined) {
      for (let i = this.idx; i < this.notes.length && this.notes[i].start < endedAt; i++) {
        const n = this.notes[i];
        if (!this.matched.has(n.id)) this.missedSet.add(n.id);
      }
    }
    const st = this.stats();
    if (st.total + st.wrong > 0) {
      this.passAccuracies.push(st.accuracy);
      this.pass++;
    }
    this.clearPass(from);
  }

  /** The arrangement was edited: score the new notes from `from` (call newPass first). */
  replaceNotes(notes: Note[], hands: Record<Hand, boolean>, from: number): void {
    this.notes = notes.filter((n) => hands[n.hand]).sort((a, b) => a.start - b.start);
    this.matched.clear();
    this.missedSet.clear();
    this.seek(from);
  }

  /** Song time jumped forward (seek): the notes in between are skipped, not missed. */
  skipTo(t: number): void {
    const before = this.idx;
    this.seek(t);
    if (this.idx < before) this.idx = before;
  }

  /** Register a key press at song time `t` (already scaled for playback speed). */
  press(midi: number, t: number, rate = 1): { result: 'correct' | 'wrong'; offsetMs?: number; noteId?: number } {
    const win = this.windowSec * Math.max(1, 1 / rate);
    let best: Note | null = null;
    for (let i = this.idx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.start > t + win) break;
      if (n.midi !== midi || this.matched.has(n.id) || this.missedSet.has(n.id)) continue;
      if (Math.abs(n.start - t) <= win && (!best || Math.abs(n.start - t) < Math.abs(best.start - t))) best = n;
    }
    if (best) {
      this.matched.add(best.id);
      const off = (t - best.start) * 1000 * rate; // in real-time ms
      this.timing.push(off);
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      return { result: 'correct', offsetMs: off, noteId: best.id };
    }
    this.wrong++;
    this.streak = 0;
    return { result: 'wrong' };
  }

  /** Advance time; returns ids of notes that just became "missed". */
  update(t: number, rate = 1): number[] {
    const win = this.windowSec * Math.max(1, 1 / rate);
    const missed: number[] = [];
    while (this.idx < this.notes.length && this.notes[this.idx].start < t - win) {
      const n = this.notes[this.idx];
      if (!this.matched.has(n.id)) {
        this.missedSet.add(n.id);
        missed.push(n.id);
        this.streak = 0;
      }
      this.idx++;
    }
    return missed;
  }

  /** Wait mode: the next chord the player must play (unmatched notes starting together). */
  nextPending(t: number): { time: number; midis: number[] } | null {
    for (let i = this.idx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (this.matched.has(n.id) || this.missedSet.has(n.id)) continue;
      if (n.start < t - this.windowSec) continue;
      const group = this.notes.filter((m) => Math.abs(m.start - n.start) < 0.04 && !this.matched.has(m.id) && !this.missedSet.has(m.id));
      return { time: n.start, midis: group.map((g) => g.midi) };
    }
    return null;
  }

  stats(): PracticeStats {
    const correct = this.matched.size;
    const missed = this.missedSet.size;
    const total = correct + missed;
    const abs = this.timing.length ? this.timing.reduce((s, v) => s + Math.abs(v), 0) / this.timing.length : 0;
    const signed = this.timing.length ? this.timing.reduce((s, v) => s + v, 0) / this.timing.length : 0;
    const denom = total + this.wrong;
    return {
      correct,
      wrong: this.wrong,
      missed,
      total,
      meanAbsTimingMs: Math.round(abs),
      meanSignedTimingMs: Math.round(signed),
      accuracy: denom ? Math.round((correct / denom) * 1000) / 10 : 0,
      streak: this.streak,
      bestStreak: this.bestStreak,
      pass: this.pass,
      bestAccuracy: this.passAccuracies.length ? Math.max(...this.passAccuracies) : null,
    };
  }
}

/**
 * Feed the current song time to the scorer's pass logic (call before update()/nextPending()).
 * A jump back starts a new pass; a jump forward skips the notes in between. With `loop` (the active
 * A-B loop), a jump back that is the loop wrapping closes the pass at the loop end, so the notes
 * between the last check and the loop end are scored too.
 */
export function followSongTime(
  scorer: PracticeScorer,
  jumps: TimeJumpDetector,
  t: number,
  advance: number,
  loop?: { start: number; end: number } | null,
): 'back' | 'forward' | null {
  const before = jumps.high;
  const jump = jumps.check(t, advance);
  if (jump === 'back') scorer.newPass(t, before === null ? undefined : loopWrapEnd(before, t, advance, loop) ?? before);
  else if (jump === 'forward') scorer.skipTo(t);
  return jump;
}

/** The loop end when song time went from `before` to `t` by wrapping around `loop`, else null. */
export function loopWrapEnd(before: number, t: number, advance: number, loop?: { start: number; end: number } | null): number | null {
  if (!loop || loop.end <= loop.start) return null;
  const toEnd = loop.end - before; // played before the wrap
  const fromStart = t - loop.start; // played after it
  const slack = 0.05;
  if (toEnd < -slack || fromStart < -slack) return null;
  return toEnd + fromStart <= Math.max(0, advance) + JUMP_TOLERANCE_SEC ? loop.end : null;
}

/**
 * The scorer only looks at which notes there are (pitch, hand, start). A change that leaves them as
 * they are (the automatic pedal, a note's colour) must not start a new pass.
 */
export function sameScoredNotes(a: readonly Note[], b: readonly Note[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.midi !== y.midi || x.start !== y.start || x.hand !== y.hand) return false;
  }
  return true;
}
