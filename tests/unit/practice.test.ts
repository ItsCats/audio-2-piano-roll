import { describe, expect, it } from 'vitest';
import { PracticeScorer } from '../../src/lib/midiInput/practice';
import { buildEvents } from '../../src/lib/audio/events';
import type { Note } from '../../src/lib/music/types';

const notes: Note[] = [
  { id: 1, midi: 60, start: 1, dur: 0.5, vel: 0.7, hand: 'R' },
  { id: 2, midi: 64, start: 2, dur: 0.5, vel: 0.7, hand: 'R' },
  { id: 3, midi: 48, start: 2, dur: 1, vel: 0.7, hand: 'L' },
  { id: 4, midi: 67, start: 3, dur: 0.5, vel: 0.7, hand: 'R' },
];

describe('practice scoring', () => {
  it('scores correct, wrong and missed notes with timing', () => {
    const s = new PracticeScorer(notes, { L: false, R: true }, 150);
    s.reset(0);
    expect(s.press(60, 1.05).result).toBe('correct');
    expect(s.press(61, 1.5).result).toBe('wrong');
    s.update(2.5); // note 64 at t=2 missed
    expect(s.press(67, 2.95).result).toBe('correct');
    const st = s.stats();
    expect(st).toMatchObject({ correct: 2, wrong: 1, missed: 1 });
    expect(st.meanSignedTimingMs).toBe(0); // +50 and -50
    expect(st.accuracy).toBe(50);
  });
  it('reports the next chord to wait for', () => {
    const s = new PracticeScorer(notes, { L: true, R: true });
    s.reset(0);
    s.press(60, 1);
    expect(s.nextPending(1.2)).toEqual({ time: 2, midis: [64, 48] });
  });
});

describe('playback events', () => {
  it('orders note-offs before pedal before note-ons at equal times and honours hand muting', () => {
    const ev = buildEvents(
      [
        { id: 1, midi: 60, start: 0, dur: 1, vel: 0.5, hand: 'R' },
        { id: 2, midi: 62, start: 1, dur: 1, vel: 0.5, hand: 'R' },
        { id: 3, midi: 40, start: 0, dur: 1, vel: 0.5, hand: 'L' },
      ],
      [{ start: 1, end: 2 }],
      { L: false, R: true },
    );
    expect(ev.map((e) => `${e.t}:${e.kind}`)).toEqual(['0:on', '1:off', '1:pedal', '1:on', '2:off', '2:pedal']);
  });
});
