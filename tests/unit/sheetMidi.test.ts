/** The MIDI download of an edited sheet: key (FF 59), time (FF 58) and tempo (FF 51) changes at the right ticks. */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Song } from '../../src/lib/music/types';
import { buildSheet } from '../../src/lib/sheet';
import { ensureSheet } from '../../src/lib/sheet/lock';
import { retime } from '../../src/lib/sheet/retime';
import { sheetMidiMeta } from '../../src/lib/sheet/midiMeta';
import { exportMidi } from '../../src/lib/music/midi';
import { GOLDEN_SONGS } from './sheetSongs';

const require = createRequire(import.meta.url);
const { Midi } = require('@tonejs/midi');
const demo = () => GOLDEN_SONGS[0][1]();
const midiOf = (song: Song) => {
  const arr = song.arrangements.hard;
  return new Midi(exportMidi(arr.notes, arr.pedal, song.tempo, song.title, sheetMidiMeta(song, 'hard')));
};

describe('MIDI meta events from the sheet', () => {
  it('a song without sheet changes gets no extra events (same bytes as before)', () => {
    const s = demo();
    const arr = s.arrangements.hard;
    expect(sheetMidiMeta(s, 'hard')).toBeUndefined();
    expect(sheetMidiMeta({ ...s, sheet: ensureSheet(s, 'hard') }, 'hard')).toBeUndefined();
    expect(Buffer.from(exportMidi(arr.notes, arr.pedal, s.tempo, s.title, undefined))).toEqual(Buffer.from(exportMidi(arr.notes, arr.pedal, s.tempo, s.title)));
  });

  it('key and time changes land on the tick of their bar; notes keep their seconds', () => {
    const base = demo();
    const sheet = ensureSheet(base, 'hard');
    const s0: Song = { ...base, sheet };
    const t = buildSheet(s0, 'hard').time;
    const p4 = t.measureStart(4);
    const p8 = t.measureStart(8);
    const song: Song = { ...s0, sheet: { ...sheet, keys: [{ pos: p4, fifths: 2, mode: 'major' }], meters: [{ pos: p8, beatsPerBar: 3, beatUnit: 4 }] } };
    const midi = midiOf(song);
    const h = midi.header;
    const time = buildSheet(song, 'hard').time;
    expect(h.keySignatures).toHaveLength(1);
    expect(h.keySignatures[0]).toMatchObject({ key: 'D', scale: 'major', ticks: h.secondsToTicks(time.posToTime(p4)) });
    const ts = h.timeSignatures.find((x: { timeSignature: number[] }) => x.timeSignature[0] === 3);
    expect(ts.ticks).toBe(h.secondsToTicks(time.posToTime(p8)));
    expect(h.timeSignatures[0].ticks).toBe(0);
    // a quarter-per-beat 4/4 song at a steady tempo: bar 4 starts 4 × 4 beats in (± a tick)
    const notes = midi.tracks.flatMap((tr: { notes: { time: number }[] }) => tr.notes).map((n: { time: number }) => n.time).sort((a: number, b: number) => a - b);
    const want = song.arrangements.hard.notes.map((n) => n.start).sort((a, b) => a - b);
    notes.forEach((x: number, i: number) => expect(Math.abs(x - want[i])).toBeLessThan(0.01));
  });

  it('every key from 7 flats to 7 sharps, major and minor, reads back', () => {
    const base = demo();
    const sheet = ensureSheet(base, 'hard');
    const t = buildSheet({ ...base, sheet }, 'hard').time;
    const keys = Array.from({ length: 15 }, (_, i) => ({ pos: t.measureStart(i + 1), fifths: i - 7, mode: (i % 2 ? 'minor' : 'major') as 'major' | 'minor' }));
    const h = midiOf({ ...base, sheet: { ...sheet, keys } }).header;
    const names = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
    expect(h.keySignatures.map((k: { key: string; scale: string }) => [k.key, k.scale])).toEqual(keys.map((k) => [names[k.fifths + 7], k.mode]));
  });

  it('a re-timed tempo mark becomes a tempo event; the notes after it keep their seconds', () => {
    const base = demo();
    const s0: Song = { ...base, sheet: ensureSheet(base, 'hard') };
    const pos = buildSheet(s0, 'hard').time.measureStart(4);
    const marked: Song = { ...s0, sheet: { ...s0.sheet!, tempos: [{ pos, bpm: 90, unit: 'q', retimed: true }] } };
    const song: Song = { ...marked, ...retime(marked, pos, 90).patch };
    const midi = midiOf(song);
    const h = midi.header;
    const ev = h.tempos.find((x: { bpm: number }) => Math.abs(x.bpm - 90) < 0.01);
    expect(ev).toBeTruthy();
    expect(Math.abs(ev.time - buildSheet(song, 'hard').time.posToTime(pos))).toBeLessThan(0.01);
    const got = midi.tracks.flatMap((tr: { notes: { time: number }[] }) => tr.notes).map((n: { time: number }) => n.time).sort((a: number, b: number) => a - b);
    const want = song.arrangements.hard.notes.map((n) => n.start).sort((a, b) => a - b);
    got.forEach((x: number, i: number) => expect(Math.abs(x - want[i])).toBeLessThan(0.01));
    // and the bar after the mark is 90 qpm long in ticks: 4 beats × ppq
    const t = buildSheet(song, 'hard').time;
    const a = h.secondsToTicks(t.posToTime(t.measureStart(5)));
    const b = h.secondsToTicks(t.posToTime(t.measureStart(6)));
    expect(Math.abs(b - a - 4 * h.ppq)).toBeLessThanOrEqual(2);
  });

  it('a label-only tempo mark (song with a recording) adds no tempo event', () => {
    const base = demo();
    const s0: Song = { ...base, sheet: ensureSheet(base, 'hard') };
    const song: Song = { ...s0, sheet: { ...s0.sheet!, tempos: [{ pos: 0, bpm: 100, unit: 'q', retimed: false }] } };
    expect(midiOf(song).header.tempos).toHaveLength(1);
  });
});
