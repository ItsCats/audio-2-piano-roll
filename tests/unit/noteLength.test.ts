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

  it('a note ringing through a pedal change is held until the next pedal goes down (at most 1.5 s longer)', () => {
    // pedal-up at 2 s (60 and 62 ring past their key-ups and stop together); 48 (left hand) rings on to 3 s
    const notes = [n(60, 0, 2), n(62, 0.3, 2), n(64, 0.5, 2), n(48, 1, 3), n(41, 1.4, 3), n(67, 2.2, 3), n(69, 2.6, 3)];
    const r = asPlayed(notes);
    expect(r.pedal).toEqual([{ start: 0, end: 2 }, { start: 2.08, end: 3 }]);
    const by = new Map(r.notes.map((x) => [x.midi, x]));
    // 48's next left-hand onset is at 1.4 s; it rings past the pedal-up at 2 s, so its key was down until the pedal went down again
    expect(end(by.get(48)!)).toBeCloseTo(2.1, 3);
    // played back, every note rings as the model heard it
    expect(asHeard(r.notes, r.pedal).map(end)).toEqual(notes.map(end));
    // further than 1.5 s: the note is drawn to its key-up (it is damped at the pedal change in playback)
    const far = [n(60, 0, 4), n(62, 0.3, 4), n(64, 0.5, 4), n(48, 1, 6), n(41, 1.4, 6), n(67, 4.2, 6), n(69, 4.6, 6)];
    const f = asPlayed(far);
    expect(end(f.notes[3])).toBe(1.4);
  });

  it('a cadence: voices held by the fingers and let go together are not a pedal-up', () => {
    // a two-voice cadence without pedal: the upper voice is held over a moving lower voice, then both are let go
    const notes = [n(72, 0, 2), n(67, 0, 0.5), n(65, 0.5, 1), n(64, 1, 2), n(48, 0, 2), n(43, 2.2, 2.6)];
    const r = asPlayed(notes);
    expect(r.pedal).toEqual([]);
    expect(r.notes).toEqual(notes);
  });

  it('notes the model closed at its 6 s limit are no pedal evidence, and are cut where a pedal carries them', () => {
    // 50 and 53 never ended in the model (6.00 s); the hand plays on and a pedal-up at 5 s carries the rest
    const notes = [n(50, 0, 6), n(53, 0, 6), n(45, 0.5, 5), n(47, 1, 5), n(60, 0, 5), n(64, 1, 5), n(67, 2, 5)];
    const r = asPlayed(notes);
    expect(r.pedal).toEqual([{ start: 0, end: 5 }]);
    const by = new Map(r.notes.map((x) => [x.midi, x]));
    expect(end(by.get(50)!)).toBe(0.5);
    expect(end(by.get(53)!)).toBe(0.5);
    // alone (no pedal anywhere), a capped note is kept: nothing says when its key went up
    const alone = asPlayed([n(50, 0, 6), n(45, 0.5, 0.9), n(47, 1, 1.4)]);
    expect(alone.pedal).toEqual([]);
    expect(end(alone.notes[0])).toBe(6);
  });

  it('a melody note played louder than the notes under it is held to the next melody note', () => {
    const loud = (x: Note): Note => ({ ...x, vel: 0.85 });
    const soft = (x: Note): Note => ({ ...x, vel: 0.5 });
    // under the pedal: melody 76 (loud) over a soft right-hand accompaniment, next melody note 77 at 1.5 s
    const notes = [loud(n(76, 0, 3)), soft(n(64, 0.25, 3)), soft(n(67, 0.5, 3)), soft(n(64, 0.75, 3)), soft(n(67, 1, 3)), loud(n(77, 1.5, 3)), soft(n(65, 1.75, 3)), n(40, 0, 3), n(47, 1, 3)];
    const r = asPlayed(notes);
    expect(end(r.notes[0])).toBe(1.5);
    // the accompaniment still ends at the next onset
    expect(end(r.notes[1])).toBe(0.5);
    // without the loudness difference the melody note ends at the next onset like the others
    const flat = asPlayed(notes.map((x) => ({ ...x, vel: 0.6 })));
    expect(end(flat.notes[0])).toBe(0.25);
    // and so does a note that is not the top of the right hand
    const under = asPlayed([...notes, soft(n(79, 0, 0.2))]);
    expect(end(under.notes[0])).toBe(0.25);
  });

  it('the pedal goes down after keys the model heard stop, unless holding the carried keys longer costs more', () => {
    // 62 (right) stops at 0.9 s, before the right hand's next onset: let go with the pedal up; the pedal goes down just after
    const notes = [n(60, 0, 3), n(62, 0.5, 0.9), n(64, 1.0, 3), n(67, 1.5, 3), n(40, 0, 3), n(43, 0.4, 3)];
    const r = asPlayed(notes);
    expect(r.pedal).toEqual([{ start: 0.91, end: 3 }]);
    // a legato key (stops at the next onset) weighs half: here holding 60 and 40 longer costs more, the pedal goes down at once
    const legato = asPlayed(notes.map((x) => (x.midi === 62 ? { ...x, dur: 0.5 } : x)));
    expect(legato.pedal).toEqual([{ start: 0, end: 3 }]);
    // with holding made expensive, the pedal goes down at once and 62 rings (a smaller error than 60 and 40 held)
    const r2 = asPlayed(notes, { holdCost: 10 });
    expect(r2.pedal).toEqual([{ start: 0, end: 3 }]);
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

  it('back and forth (As played, As heard, As played) gives the as-played notes and pedal back exactly, also after many switches', () => {
    // (on real pieces, working the notes out again from the notes as heard changes some ends by ~10 ms)
    const notes: Note[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i * 0.23;
      const up = Math.floor(i / 7) * 1.61 + 1.6;
      notes.push({ ...n(60 + ((i * 5) % 14), t, up), vel: 0.4 + (i % 5) * 0.1 }, n(40 + ((i * 3) % 9), t + 0.01, Math.min(up, t + 0.5 + (i % 3) * 0.4)));
    }
    const r = asPlayed(notes.map((x, i) => ({ ...x, id: i + 1 })));
    const s = buildSong({ title: 't', source: { kind: 'audio' }, notes: r.notes, pedal: r.pedal, tempo, duration: 100, transcription: SPECIALIST, hasAudio: true, hasPosteriors: false, autoPedal: false, noteLength: 'played' });
    let x = s;
    for (let k = 0; k < 4; k++) {
      x = withNoteLength(x, 'heard');
      expect(x.notesAsPlayed).toEqual({ base: s.base, pedal: s.basePedal });
      x = withNoteLength(x, 'played');
      expect(x.base).toEqual(s.base);
      expect(x.basePedal).toEqual(s.basePedal);
      expect('notesAsPlayed' in x).toBe(false);
    }
    // the kept notes are only used while they still match the notes as heard
    const heard = withNoteLength(s, 'heard');
    const moved: Song = { ...heard, base: heard.base.map((y, i) => (i === 3 ? { ...y, start: y.start + 0.05 } : y)) };
    expect(withNoteLength(moved, 'played').base).toEqual(asPlayed(moved.base).notes);
  });

  it('the automatic pedal is kept when switching back to As played; only an older song turns it off', () => {
    const s = withAutoPedal(freshImport(), true);
    const back = withNoteLength(withNoteLength(s, 'heard'), 'played');
    expect(back.autoPedal).toBe(true);
    expect(back.arrangements.hard.pedal).toEqual(s.arrangements.hard.pedal);
    // an older song (automatic pedal on by default then) gets the pedal heard in the recording
    expect(withNoteLength(oldSong(), 'played').autoPedal).toBe(false);
  });

  it('Easy (no pedal) is built from the notes as they ring, as for every other song; Medium and Hard from the notes as played', () => {
    const fresh = freshImport();
    const old = oldSong();
    const strip = (ns: Note[]) => ns.map(({ id: _id, ...x }) => (void _id, x));
    expect(strip(fresh.arrangements.easy.notes)).toEqual(strip(old.arrangements.easy.notes));
    expect(fresh.arrangements.easy.notes.map(end)).toEqual(old.arrangements.easy.notes.map(end));
    expect(fresh.arrangements.hard.notes.map(end)).toEqual(fresh.base.map(end));
    // As heard: the same Easy
    expect(strip(withNoteLength(fresh, 'heard').arrangements.easy.notes)).toEqual(strip(old.arrangements.easy.notes));
    const opts = { easyAsHeard: true };
    expect(strip(generateAllArrangements(fresh.base, fresh.basePedal, tempo, 5, opts).easy.notes)).toEqual(strip(old.arrangements.easy.notes));
  });

  it('undo of a note-length switch also puts back the library picture', () => {
    const s = freshImport();
    const before: Song = { ...s, thumbnail: 'data:image/png;base64,AAAA' };
    useStudio.getState().openSong(before);
    useStudio.getState().editSong(() => ({ noteLength: 'heard', thumbnail: 'data:image/png;base64,BBBB' }));
    expect(useStudio.getState().song!.thumbnail).toBe('data:image/png;base64,BBBB');
    useStudio.getState().undo();
    expect(useStudio.getState().song!.thumbnail).toBe('data:image/png;base64,AAAA');
    useStudio.getState().redo();
    expect(useStudio.getState().song!.thumbnail).toBe('data:image/png;base64,BBBB');
  });

  it('levels: Medium and Hard play the base pedal when the automatic pedal is off (no change to the arrangement code)', () => {
    const r = asPlayed(brokenChord());
    const all = generateAllArrangements(r.notes, r.pedal, tempo, 5, { autoPedal: false });
    expect(all.hard.pedal).toEqual(r.pedal);
    expect(all.medium.pedal).toEqual(r.pedal);
  });
});
