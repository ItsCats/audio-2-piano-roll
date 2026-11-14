import { describe, expect, it, vi } from 'vitest';
import { AS_PLAYED, asHeard, asPlayed } from '../../src/lib/music/noteLength';
import { buildSong, hasNoteLength, noteLengthOf, withAutoPedal, withNoteLength } from '../../src/lib/songs';
import { generateAllArrangements } from '../../src/lib/music/difficulty';
import type { Note, PedalRange, Song, TempoInfo, TranscriptionInfo } from '../../src/lib/music/types';

vi.mock('../../src/lib/storage/db', async (orig) => ({ ...(await orig<object>()), getSong: vi.fn(), saveSong: vi.fn(async () => undefined) }));
vi.mock('../../src/state/playback', () => ({ getPlayer: () => ({ isPlaying: false, liveNoteOn() {}, liveNoteOff() {} }) }));
vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });
const { useStudio } = await import('../../src/state/studioStore');

let id = 100;
const n = (midi: number, start: number, end: number, hand: 'L' | 'R' = midi < 60 ? 'L' : 'R'): Note => ({ id: id++, midi, start, dur: +(end - start).toFixed(3), vel: 0.7, hand });
const end = (x: Note) => +(x.start + x.dur).toFixed(3);
const tempo: TempoInfo = { bpm: 120, beats: Array.from({ length: 40 }, (_, i) => i * 0.5), beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'estimated' };
const SPECIALIST: TranscriptionInfo = { method: 'piano-specialist', estimated: true, warnings: [] };

/** A pedalled broken chord in the right hand over a held bass: every note rings to the pedal-up at 3.5 s. */
function brokenChord(): Note[] {
  const notes = [n(36, 0.5, 3.5), n(60, 0.5, 3.5), n(64, 1, 3.5), n(67, 1.5, 3.5), n(72, 2, 3.5)];
  return notes.map((x, i) => ({ ...x, id: i + 1 }));
}

describe('asPlayed: notes as long as the key is held, and the pedal heard in the recording', () => {
  it('a pedalled broken chord: each note ends at the same hand’s next onset, one pedal range ends at the shared end', () => {
    const notes = brokenChord();
    const r = asPlayed(notes);
    expect(r.notes.map(end)).toEqual([3.5, 1, 1.5, 2, 3.5]);
    expect(r.pedal).toEqual([{ start: 0.5, end: 3.5 }]);
    // as heard gives the model's ends back
    expect(asHeard(r.notes, r.pedal).map(end)).toEqual([3.5, 3.5, 3.5, 3.5, 3.5]);
  });

  it('staccato notes without pedal are unchanged and get no pedal', () => {
    const notes = [n(60, 0, 0.2), n(64, 0.5, 0.65), n(67, 1, 1.18), n(72, 1.5, 1.6)];
    const r = asPlayed(notes);
    expect(r.notes).toEqual(notes);
    expect(r.pedal).toEqual([]);
  });

  it('a block chord let go by the fingers (no note rings past its key-up) is unchanged', () => {
    const notes = [n(60, 0, 1), n(64, 0, 1), n(67, 0.01, 1), n(62, 1, 2), n(65, 1, 2)];
    const r = asPlayed(notes);
    expect(r.notes).toEqual(notes);
    expect(r.pedal).toEqual([]);
  });

  it('a re-strike of the same key under the pedal is not a pedal-up; the first note is still carried', () => {
    // 60 rings until it is struck again at 2 s (the sound ends there because of the re-strike, not a damper)
    const notes = [n(60, 0, 2), n(64, 0.5, 3), n(67, 1, 3), n(60, 2, 3)];
    const r = asPlayed(notes);
    expect(r.pedal).toHaveLength(1);
    expect(r.pedal[0].end).toBe(3);
    expect(r.notes.map(end)).toEqual([0.5, 1, 2, 3]);
    // played back, the first 60 rings until the re-strike
    expect(asHeard(r.notes, r.pedal).map(end)).toEqual([2, 3, 3, 3]);
  });

  it('a lone long note under moving notes keeps its full length (the finger held it)', () => {
    const melody = n(72, 0, 2);
    const notes = [melody, n(64, 0, 0.2), n(65, 0.5, 0.7), n(67, 1, 1.2), n(65, 1.5, 1.7), n(64, 2, 2.4)];
    const r = asPlayed(notes);
    expect(end(r.notes[0])).toBe(2);
    expect(r.pedal).toEqual([]);
  });

  it('a note ringing past a pedal-up was held through it: its key-up moves to that pedal-up', () => {
    // pedal-up at 2 s (60 and 64 stop together); 55 (left hand) rings on to 3 s with 67 and 69
    const notes = [n(55, 0, 3), n(60, 0, 2), n(64, 0.5, 2), n(43, 0.6, 1.5), n(67, 2.2, 3), n(69, 2.6, 3), n(45, 2.2, 2.5)];
    const r = asPlayed(notes);
    const by = new Map(r.notes.map((x) => [x.midi, x]));
    // 55's next left-hand onset is at 0.6 s, but it sounds past the pedal-up at 2 s: held until then
    expect(end(by.get(55)!)).toBeGreaterThanOrEqual(2);
    expect(r.pedal.some((p) => p.end === 2)).toBe(true);
  });

  it('a key let go without pedal delays the pedal going down until it is released', () => {
    // 50 (left) stops at 1.0 s, well before the left hand's next onset at 1.5 s: let go with the pedal up
    const notes = [n(48, 0, 0.4), n(50, 0.5, 1.0), n(52, 1.5, 3), n(60, 0.2, 3), n(64, 0.6, 3), n(67, 1.6, 3)];
    const r = asPlayed(notes);
    expect(r.pedal).toHaveLength(1);
    expect(r.pedal[0].start).toBeCloseTo(1.01, 3);
    expect(r.pedal[0].end).toBe(3);
    // the carried notes let go before that are held until just after the pedal went down
    const by = new Map(r.notes.map((x) => [x.midi, x]));
    expect(end(by.get(60)!)).toBeCloseTo(1.03, 3);
  });

  it('notes of the top octave and a half (no dampers) never delay the pedal', () => {
    const notes = [n(96, 0.5, 1.0), n(97, 1.5, 1.6), n(60, 0.2, 3), n(64, 0.6, 3), n(67, 1.6, 3), n(40, 0, 3)];
    const r = asPlayed(notes);
    expect(r.pedal).toEqual([{ start: 0.2, end: 3 }]);
  });

  it('hands are separate: a left-hand onset does not end a right-hand note, chord mates do not end each other', () => {
    const notes = [n(64, 0, 2), n(67, 0.02, 2), n(40, 0.5, 2), n(43, 1, 2), n(72, 1.5, 2)];
    const r = asPlayed(notes);
    const by = new Map(r.notes.map((x) => [x.midi, x]));
    // 64 and 67 (a chord) end at the right hand's next onset (1.5 s), not at the left hand's 0.5 s or at each other
    expect(end(by.get(64)!)).toBe(1.5);
    expect(end(by.get(67)!)).toBe(1.5);
    expect(end(by.get(40)!)).toBe(1);
    expect(r.pedal).toEqual([{ start: 0, end: 2 }]);
  });

  it('keeps a minimum length, onsets, ids, order and every other field; is deterministic', () => {
    const notes = [n(60, 0, 1), n(62, 0.03, 1), n(64, 0.05, 1), n(65, 0.07, 1), n(36, 0, 1)];
    notes[0].role = 'melody';
    const r = asPlayed(notes);
    for (const x of r.notes) expect(x.dur).toBeGreaterThanOrEqual(AS_PLAYED.minDur - 1e-9);
    expect(r.notes.map((x) => [x.id, x.start, x.midi, x.vel, x.hand])).toEqual(notes.map((x) => [x.id, x.start, x.midi, x.vel, x.hand]));
    expect(r.notes[0].role).toBe('melody');
    expect(asPlayed(notes)).toEqual(r);
    expect(asPlayed([])).toEqual({ notes: [], pedal: [] });
  });

  it('is fast: 10,000 notes well under 100 ms', () => {
    const notes: Note[] = [];
    for (let i = 0; i < 2500; i++) {
      const t = i * 0.25;
      const up = Math.floor(i / 8) * 2 + 2; // pedal changes every 2 s
      notes.push(n(60 + (i % 12), t, up), n(48 + (i % 7), t, up), n(72 + (i % 5), t + 0.1, up), n(36 + (i % 3), t, Math.min(up, t + 0.24)));
    }
    asPlayed(notes);
    const t0 = performance.now();
    const r = asPlayed(notes);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(r.pedal.length).toBeGreaterThan(100);
  });

  it('asHeard: a key let go under the pedal sounds to the pedal-up; overlapping ranges are one pedal', () => {
    const notes = [n(60, 0, 0.5), n(64, 1, 1.2), n(67, 3, 3.5)];
    const pedal: PedalRange[] = [
      { start: 0.2, end: 1.5 },
      { start: 1.4, end: 2 },
    ];
    expect(asHeard(notes, pedal).map(end)).toEqual([2, 2, 3.5]);
    expect(asHeard(notes, [])).toEqual(notes);
  });
});

describe('songs from the high-accuracy piano model: note length', () => {
  /** an older song (before note lengths): notes as heard, automatic pedal on */
  const oldSong = (): Song => buildSong({
    title: 't', source: { kind: 'audio' }, notes: brokenChord(), pedal: [], tempo, duration: 5, transcription: SPECIALIST, hasAudio: true, hasPosteriors: false, autoPedal: true,
  });
  /** a fresh import: what the import builds from the pipeline's result */
  const freshImport = (): Song => {
    const r = asPlayed(brokenChord());
    return buildSong({ title: 't', source: { kind: 'audio' }, notes: r.notes, pedal: r.pedal, tempo, duration: 5, transcription: SPECIALIST, hasAudio: true, hasPosteriors: false, autoPedal: false, noteLength: 'played' });
  };

  it('a fresh import is as played, with the recorded pedal on Medium and Hard and the automatic pedal off', () => {
    const s = freshImport();
    expect(s.noteLength).toBe('played');
    expect(s.autoPedal).toBe(false);
    expect(s.basePedal).toEqual([{ start: 0.5, end: 3.5 }]);
    expect(s.arrangements.hard.pedal).toEqual(s.basePedal);
    expect(s.arrangements.medium.pedal).toEqual(s.basePedal);
    expect(s.arrangements.easy.pedal).toEqual([]);
    expect(hasNoteLength(s)).toBe(true);
    // the automatic pedal can still be switched on, and off gives the recorded pedal back
    const on = withAutoPedal(s, true);
    expect(on.arrangements.hard.pedal).not.toEqual(s.basePedal);
    expect(withAutoPedal(on, false).arrangements.hard.pedal).toEqual(s.basePedal);
  });

  it('noteLength is only kept for the high-accuracy model', () => {
    const s = buildSong({ title: 't', source: { kind: 'audio' }, notes: brokenChord(), pedal: [], tempo, duration: 5, transcription: { method: 'basic-pitch', estimated: true, warnings: [] }, hasAudio: true, hasPosteriors: true, noteLength: 'played' });
    expect(s.noteLength).toBeUndefined();
    expect(hasNoteLength(s)).toBe(false);
  });

  it('an older song shows As heard; switching to As played gives exactly what a fresh import gives', () => {
    const old = oldSong();
    expect(noteLengthOf(old)).toBe('heard');
    const played = withNoteLength(old, 'played');
    const fresh = freshImport();
    expect(played.noteLength).toBe('played');
    expect(played.autoPedal).toBe(false);
    expect(played.base).toEqual(fresh.base);
    expect(played.basePedal).toEqual(fresh.basePedal);
    for (const d of ['easy', 'medium', 'hard'] as const) {
      // (Easy and Medium make new note ids each time they are generated)
      const strip = (ns: Note[]) => ns.map(({ id: _id, ...x }) => (void _id, x));
      expect(strip(played.arrangements[d].notes)).toEqual(strip(fresh.arrangements[d].notes));
      expect(played.arrangements[d].pedal).toEqual(fresh.arrangements[d].pedal);
    }
  });

  it('As heard keeps the pedal (same sound) and lengthens the notes; back to As played gives the same notes', () => {
    const s = freshImport();
    const heard = withNoteLength(s, 'heard');
    expect(heard.noteLength).toBe('heard');
    expect(heard.basePedal).toEqual(s.basePedal);
    expect(heard.autoPedal).toBe(false);
    expect(heard.base.map(end)).toEqual([3.5, 3.5, 3.5, 3.5, 3.5]);
    expect(heard.arrangements.hard.pedal).toEqual(s.basePedal);
    const again = withNoteLength(heard, 'played');
    expect(again.base).toEqual(s.base);
    expect(again.basePedal).toEqual(s.basePedal);
  });

  it('switching keeps the sheet grid, fingering and markings, and replaces note fixes', () => {
    const s = freshImport();
    const hard = s.arrangements.hard;
    const fingered = hard.notes.map((x, i) => (i === 1 ? { ...x, finger: 3 as const, pin: { on: 0, off: 12, t: x.start, d: x.dur } } : x));
    const edited: Song = {
      ...s,
      sheet: { v: 1, grid: { beats: [0, 0.5, 1], db: 0, bpm: 120, beatsPerBar: 4, beatUnit: 4, originQ: 0, pickup: 0 } },
      arrangements: {
        ...s.arrangements,
        hard: { ...hard, notes: [...fingered, { ...fingered[0], id: 999, midi: 90 }], edited: true, marks: [{ id: 'm1', kind: 'dyn', pos: 0, staff: 0, value: 'p' }] },
      },
    };
    const heard = withNoteLength(edited, 'heard');
    expect(heard.sheet).toEqual(edited.sheet);
    const h = heard.arrangements.hard;
    expect(h.notes.some((x) => x.id === 999)).toBe(false); // the added note (a note fix) is replaced
    expect(h.notes.find((x) => x.midi === 60)!.finger).toBe(3);
    expect(h.notes.some((x) => x.pin)).toBe(false);
    expect(h.marks).toHaveLength(1);
    expect(h.edited).toBe(true);
  });

  it('one undo step puts back the notes, the pedal, every level, the automatic pedal and the setting', () => {
    const old = oldSong();
    useStudio.getState().openSong(old);
    const next = withNoteLength(old, 'played');
    useStudio.getState().editSong(() => ({ base: next.base, basePedal: next.basePedal, autoPedal: next.autoPedal, noteLength: next.noteLength, arrangements: next.arrangements }));
    expect(useStudio.getState().song!.noteLength).toBe('played');
    useStudio.getState().undo();
    const back = useStudio.getState().song!;
    expect('noteLength' in back).toBe(false);
    expect(back.autoPedal).toBe(true);
    expect(back.base).toEqual(old.base);
    expect(back.basePedal).toEqual([]);
    expect(back.arrangements).toEqual(old.arrangements);
    useStudio.getState().redo();
    expect(useStudio.getState().song!.noteLength).toBe('played');
    expect(useStudio.getState().song!.basePedal).toEqual(next.basePedal);
  });

  it('levels: Medium and Hard play the base pedal when the automatic pedal is off (no change to the arrangement code)', () => {
    const r = asPlayed(brokenChord());
    const all = generateAllArrangements(r.notes, r.pedal, tempo, 5, { autoPedal: false });
    expect(all.hard.pedal).toEqual(r.pedal);
    expect(all.medium.pedal).toEqual(r.pedal);
  });
});
