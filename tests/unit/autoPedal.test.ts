import { describe, expect, it } from 'vitest';
import { autoPedal, AUTO_PEDAL, isAudioSong } from '../../src/lib/music/autoPedal';
import { generateArrangement } from '../../src/lib/music/difficulty';
import { buildEvents } from '../../src/lib/audio/events';
import { arrangementOptions, buildSong, withAutoPedal } from '../../src/lib/songs';
import type { Note, PedalRange, TempoInfo } from '../../src/lib/music/types';

let id = 1;
const n = (midi: number, start: number, dur: number, hand: 'L' | 'R' = midi < 60 ? 'L' : 'R'): Note => ({ id: id++, midi, start, dur, vel: 0.7, hand });
const tempo: TempoInfo = { bpm: 120, beats: Array.from({ length: 40 }, (_, i) => i * 0.5), beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'estimated' };

/** I-IV-V-I, one chord per 2 s, a choppy right hand (detected ends far too short), then a rest. */
function song(): Note[] {
  const chords = [
    [48, 55, 64], // C
    [53, 57, 65], // F (no semitone step from the C bar's last melody note)
    [55, 59, 67], // G
    [48, 55, 67], // C
  ];
  const tune = [
    [72, 76, 79, 76],
    [77, 81, 77, 72],
    [74, 79, 83, 79],
    [76, 79, 72, 76],
  ];
  const out: Note[] = [];
  chords.forEach((c, i) => {
    const t = i * 2;
    out.push(n(c[0], t, 1.9), n(c[1], t, 1.9), n(c[2], t, 0.3, 'R'));
    tune[i].forEach((m, k) => out.push(n(m, t + k * 0.5, 0.15)));
  });
  // rest from 8 s to 10 s, then one more chord
  out.push(n(48, 10, 1), n(64, 10, 1));
  return out;
}

const covers = (pedal: PedalRange[], t: number) => pedal.some((p) => p.start <= t && p.end > t);

describe('automatic sustain pedal', () => {
  it('goes down just after each harmony change and up just before the next', () => {
    const pedal = autoPedal(song(), tempo, 12);
    for (const t of [0, 2, 4, 6]) {
      const p = pedal.find((x) => Math.abs(x.start - (t + AUTO_PEDAL.downDelay)) < 1e-6);
      expect(p, `pedal at ${t}`).toBeDefined();
    }
    for (const t of [2, 4, 6]) expect(pedal.some((p) => Math.abs(p.end - (t - AUTO_PEDAL.upLead)) < 1e-6)).toBe(true);
    // the choppy tune is held between its notes
    expect(covers(pedal, 0.3)).toBe(true);
    expect(covers(pedal, 4.4)).toBe(true);
  });

  it('never carries across a rest', () => {
    const pedal = autoPedal(song(), tempo, 12);
    for (const t of [8.2, 9, 9.9]) expect(covers(pedal, t)).toBe(false);
    expect(pedal.find((p) => p.start > 9.5)?.start).toBeCloseTo(10 + AUTO_PEDAL.downDelay, 6);
    // and the pedal before the rest is up when the last key is released
    const before = pedal.filter((p) => p.start < 8);
    expect(Math.max(...before.map((p) => p.end))).toBeLessThanOrEqual(7.9 + 1e-6);
  });

  it('is changed at least every 4 s on a long single harmony', () => {
    const notes = [n(48, 0, 12)];
    for (let t = 0; t < 12; t += 0.5) notes.push(n(t % 1 ? 76 : 79, t, 0.2));
    const pedal = autoPedal(notes, tempo, 12);
    expect(pedal.length).toBeGreaterThanOrEqual(3);
    for (const p of pedal) expect(p.end - p.start).toBeLessThanOrEqual(AUTO_PEDAL.maxHold + 1e-6);
  });

  it('changes the pedal instead of smearing a semitone clash in the same register', () => {
    // C chord; the tune steps E5 → F5 (a semitone) inside the bar
    const notes = [n(48, 0, 2), n(55, 0, 2), n(76, 0, 0.3), n(79, 0.5, 0.3), n(77, 1, 0.3), n(79, 1.5, 0.3)];
    const pedal = autoPedal(notes, tempo, 2.2);
    // E5 (released at 0.3) must not be sustained when F5 starts at 1.0
    expect(covers(pedal, 1 - 0.001)).toBe(false);
    expect(pedal.some((p) => Math.abs(p.start - (1 + AUTO_PEDAL.downDelay)) < 1e-6)).toBe(true);
  });

  it('no notes, no pedal', () => {
    expect(autoPedal([], tempo)).toEqual([]);
  });
});

describe('automatic pedal in songs', () => {
  const info = (method: 'basic-pitch' | 'midi-file') => ({ method, estimated: method !== 'midi-file', warnings: [] });

  it('Medium and Hard of an audio import get pedal; Easy keeps none', () => {
    const s = buildSong({ title: 't', source: { kind: 'file' } as never, notes: song(), pedal: [], tempo, duration: 12, transcription: info('basic-pitch'), hasAudio: true, hasPosteriors: false, autoPedal: true });
    expect(s.autoPedal).toBe(true);
    expect(s.arrangements.easy.pedal).toEqual([]);
    expect(s.arrangements.medium.pedal.length).toBeGreaterThan(0);
    expect(s.arrangements.hard.pedal.length).toBeGreaterThan(0);
    // playback, offline render and video export all play from buildEvents: the pedal is in there
    const ev = buildEvents(s.arrangements.hard.notes, s.arrangements.hard.pedal, { L: true, R: true });
    expect(ev.filter((e) => e.kind === 'pedal' && e.down).length).toBe(s.arrangements.hard.pedal.length);
    // regenerating a level keeps it
    expect(generateArrangement('hard', s.base, s.basePedal, s.tempo, s.duration, arrangementOptions(s)).pedal).toEqual(s.arrangements.hard.pedal);
  });

  it('does not touch MIDI files (their own pedal is kept)', () => {
    const own = [{ start: 0, end: 1 }];
    const s = buildSong({ title: 't', source: { kind: 'midi' } as never, notes: song(), pedal: own, tempo, duration: 12, transcription: info('midi-file'), hasAudio: false, hasPosteriors: false, autoPedal: true });
    expect(s.autoPedal).toBeUndefined();
    expect(isAudioSong(s)).toBe(false);
    expect(s.arrangements.hard.pedal).toEqual(own);
    expect(arrangementOptions({ ...s, autoPedal: true }).autoPedal).toBe(false);
  });

  it('songs saved before have it off and can switch it on (hand edits kept) and off', () => {
    const s = buildSong({ title: 't', source: { kind: 'file' } as never, notes: song(), pedal: [], tempo, duration: 12, transcription: info('basic-pitch'), hasAudio: true, hasPosteriors: false });
    expect(s.autoPedal).toBeUndefined();
    expect(s.arrangements.hard.pedal).toEqual([]);
    const edited = { ...s, arrangements: { ...s.arrangements, hard: { ...s.arrangements.hard, notes: s.arrangements.hard.notes.slice(0, 10), edited: true } } };
    const on = withAutoPedal(edited, true);
    expect(on.autoPedal).toBe(true);
    expect(on.arrangements.hard.notes).toBe(edited.arrangements.hard.notes);
    expect(on.arrangements.hard.pedal.length).toBeGreaterThan(0);
    expect(on.arrangements.easy.pedal).toEqual([]);
    const off = withAutoPedal(on, false);
    expect(off.arrangements.hard.pedal).toEqual([]);
    expect(off.arrangements.medium.pedal).toEqual([]);
  });
});
