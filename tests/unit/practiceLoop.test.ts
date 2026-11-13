import { describe, expect, it } from 'vitest';
import { PracticeScorer, TimeJumpDetector, followSongTime, loopWrapEnd, sameScoredNotes } from '../../src/lib/midiInput/practice';
import type { Note } from '../../src/lib/music/types';

// one right-hand note every 0.5 s for 30 s
const notes: Note[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, midi: 60 + (i % 12), start: i * 0.5, dur: 0.4, vel: 0.7, hand: 'R' as const }));

/** Plays [from, to) in 30 ms ticks like the practice runtime does, looping `passes` times. */
function playLoop(s: PracticeScorer, jumps: TimeJumpDetector, from: number, to: number, passes: number, onTick?: (t: number) => void) {
  const dt = 0.03;
  const perPass: { missed: number; pass: number }[] = [];
  for (let p = 0; p < passes; p++) {
    for (let t = from; t < to; t += dt) {
      followSongTime(s, jumps, t, dt);
      onTick?.(t);
      s.update(t);
    }
    perPass.push({ missed: s.stats().missed, pass: s.stats().pass });
  }
  // the wrap back to the start closes the last pass
  followSongTime(s, jumps, from, dt);
  return perPass;
}

describe('practice on an A-B loop', () => {
  it('counts the misses of an 8 s loop on every pass, not only the first', () => {
    const s = new PracticeScorer(notes, { L: true, R: true }, 150);
    const jumps = new TimeJumpDetector();
    s.reset(4);
    jumps.reset(4);
    const perPass = playLoop(s, jumps, 4, 12, 5);
    // 16 notes start in [4, 12); without key presses every one is missed on every pass
    // (the last note or two only expire at the wrap, when the pass is closed)
    for (const [i, p] of perPass.entries()) {
      expect(p.pass).toBe(i + 1);
      expect(p.missed).toBeGreaterThanOrEqual(15);
      expect(p.missed).toBeLessThanOrEqual(16);
    }
    expect(s.stats().pass).toBe(6);
    expect(s.stats().bestAccuracy).toBe(0);
  });

  it('closes a pass with the notes before the loop end counted, and keeps the best pass', () => {
    const s = new PracticeScorer(notes, { L: true, R: true }, 150);
    const jumps = new TimeJumpDetector();
    s.reset(4);
    jumps.reset(4);
    // pass 1: play everything; pass 2: play every other note
    let pass = 1;
    const loopNotes = notes.filter((n) => n.start >= 4 && n.start < 12);
    const pressed = new Set<number>();
    playLoop(s, jumps, 4, 12, 2, (t) => {
      if (s.stats().pass !== pass) {
        pass = s.stats().pass;
        pressed.clear();
      }
      for (const n of loopNotes) {
        if (pressed.has(n.id) || t < n.start) continue;
        pressed.add(n.id);
        if (pass === 1 || n.id % 2 === 0) s.press(n.midi, t);
      }
    });
    const st = s.stats();
    expect(st.pass).toBe(3);
    expect(st.bestAccuracy).toBe(100);
    expect(st.total).toBe(0); // the third pass has not started scoring yet
  });

  it('"Wait for me" waits for the first note of the loop again on the next pass', () => {
    const s = new PracticeScorer(notes, { L: true, R: true }, 150);
    const jumps = new TimeJumpDetector();
    s.reset(4);
    jumps.reset(4);
    expect(s.nextPending(4)).toEqual({ time: 4, midis: [notes[8].midi] });
    s.press(notes[8].midi, 4);
    playLoop(s, jumps, 4, 12, 1);
    // after the wrap the same note is pending again
    expect(s.nextPending(4)).toEqual({ time: 4, midis: [notes[8].midi] });
  });

  it('a seek forward skips notes instead of counting them as missed; a seek back starts a new pass', () => {
    const s = new PracticeScorer(notes, { L: true, R: true }, 150);
    const jumps = new TimeJumpDetector();
    s.reset(0);
    jumps.reset(0);
    for (let t = 0; t < 2; t += 0.03) {
      followSongTime(s, jumps, t, 0.03);
      s.update(t);
    }
    const missedBefore = s.stats().missed;
    expect(followSongTime(s, jumps, 10, 0.03)).toBe('forward');
    s.update(10);
    expect(s.stats().missed).toBe(missedBefore);
    expect(followSongTime(s, jumps, 1, 0.03)).toBe('back');
    expect(s.stats()).toMatchObject({ pass: 2, missed: 0, correct: 0 });
  });

  it('ignores the short pre-roll after a seek or a released hold, and slow drags add up', () => {
    const jumps = new TimeJumpDetector();
    jumps.reset(5);
    expect(jumps.check(5 - 0.06, 0)).toBeNull();
    expect(jumps.check(5.1, 0.03)).toBeNull();
    // dragging back 0.1 s per tick while paused
    const seen = [4.95, 4.85, 4.75].map((t) => jumps.check(t, 0));
    expect(seen).toEqual([null, null, 'back']);
  });

  it('a pass where nothing happened is not counted', () => {
    const s = new PracticeScorer(notes, { L: true, R: true }, 150);
    s.reset(0);
    s.newPass(0);
    s.newPass(0);
    expect(s.stats().pass).toBe(1);
  });

  it('the loop wrap scores the notes between the last check and the loop end', () => {
    // a note 15 ms before the loop end: the 30 ms ticks never reach it before the wrap
    const late: Note[] = [...notes.filter((n) => n.start < 11.5), { id: 999, midi: 72, start: 11.985, dur: 0.2, vel: 0.7, hand: 'R' }];
    const run = (withLoop: boolean) => {
      const s = new PracticeScorer(late, { L: true, R: true }, 150);
      const jumps = new TimeJumpDetector();
      s.reset(4);
      jumps.reset(4);
      const loop = withLoop ? { start: 4, end: 12 } : null;
      let t = 4;
      for (; t < 11.98; t += 0.03) {
        followSongTime(s, jumps, t, 0.03, loop);
        s.update(t);
        for (const n of late) if (n.start <= t && n.start > t - 0.03) s.press(n.midi, t);
      }
      // wrap: song time goes from the last tick (just under 12) to just after the loop start
      expect(followSongTime(s, jumps, 4.01, 0.03, loop)).toBe('back');
      return s.stats();
    };
    // with the loop known, the unplayed note at 11.985 is a miss of pass 1 (best below 100 %)
    expect(run(true).bestAccuracy).toBeLessThan(100);
    // without it, that note fell into the gap and pass 1 looked perfect
    expect(run(false).bestAccuracy).toBe(100);
  });

  it('tells a loop wrap from a seek back', () => {
    const loop = { start: 4, end: 12 };
    expect(loopWrapEnd(11.98, 4.01, 0.03, loop)).toBe(12);
    expect(loopWrapEnd(11.9, 4.05, 0.03, loop)).toBe(12); // within the tolerance
    expect(loopWrapEnd(9, 4, 0.03, loop)).toBeNull(); // the user sought back mid-loop
    expect(loopWrapEnd(11.98, 1, 0.03, loop)).toBeNull(); // Home: before the loop
    expect(loopWrapEnd(11.98, 4.01, 0.03, null)).toBeNull();
    expect(loopWrapEnd(11.98, 4.01, 0.03, { start: 5, end: 5 })).toBeNull();
  });

  it('a change that leaves the notes alone (e.g. the automatic pedal) is not a new arrangement for scoring', () => {
    const copy = notes.map((n) => ({ ...n }));
    expect(sameScoredNotes(notes, notes)).toBe(true);
    expect(sameScoredNotes(notes, copy)).toBe(true);
    expect(sameScoredNotes(notes, copy.slice(1))).toBe(false);
    expect(sameScoredNotes(notes, copy.map((n, i) => (i === 3 ? { ...n, midi: n.midi + 1 } : n)))).toBe(false);
    expect(sameScoredNotes(notes, copy.map((n, i) => (i === 3 ? { ...n, start: n.start + 0.01 } : n)))).toBe(false);
    expect(sameScoredNotes(notes, copy.map((n, i) => (i === 3 ? { ...n, hand: 'L' as const } : n)))).toBe(false);
    // velocity or length changes do not change what is scored
    expect(sameScoredNotes(notes, copy.map((n) => ({ ...n, vel: 0.2, dur: 1 })))).toBe(true);
  });
});
