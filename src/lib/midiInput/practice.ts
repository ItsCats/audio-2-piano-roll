/**
 * Practice scoring: compares incoming notes (MIDI keyboard or computer keyboard) with the
 * expected notes of the arrangement.
 *  - correct: right pitch within ±window of an expected, unmatched note onset
 *  - wrong:   a key press matching no expected note in the window
 *  - missed:  an expected note whose window passed without a matching press
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
  windowSec: number;

  constructor(notes: Note[], hands: Record<Hand, boolean>, windowMs = 150) {
    this.notes = notes.filter((n) => hands[n.hand]).sort((a, b) => a.start - b.start);
    this.windowSec = windowMs / 1000;
  }

  reset(from: number): void {
    this.matched.clear();
    this.missedSet.clear();
    this.timing = [];
    this.wrong = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.idx = this.notes.findIndex((n) => n.start >= from - this.windowSec);
    if (this.idx < 0) this.idx = this.notes.length;
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
    };
  }
}
