/**
 * Key, time-signature and tempo changes placed on the sheet (Song.sheet), as MIDI meta events in
 * song seconds for exportMidi: key signatures (FF 59), time signatures (FF 58) and, for tempo marks
 * that re-timed the music, tempo events (FF 51), so a DAW shows the same bars and keys. Songs
 * without sheet data get no extra events (their MIDI file is unchanged).
 */
import type { Difficulty, Song } from '../music/types';
import type { MidiMeta } from '../music/midi';
import { buildSheet } from './index';
import { TEMPO_UNIT_Q } from './score';

export function sheetMidiMeta(song: Song, level: Difficulty): MidiMeta | undefined {
  const sh = song.sheet;
  if (!sh || !(sh.keys?.length || sh.meters?.length || sh.tempos?.length)) return undefined;
  const time = buildSheet(song, level).time;
  const at = (pos: number) => Math.max(0, time.posToTime(pos));
  return {
    keys: (sh.keys ?? []).map((k) => ({ time: at(k.pos), fifths: Math.max(-7, Math.min(7, Math.round(k.fifths))), mode: k.mode })),
    meters: (sh.meters ?? []).map((m) => ({ time: at(m.pos), beatsPerBar: m.beatsPerBar, beatUnit: m.beatUnit })),
    tempos: (sh.tempos ?? []).filter((t) => t.retimed).map((t) => ({ time: at(t.pos), qpm: t.bpm * (TEMPO_UNIT_Q[t.unit] ?? 1) })),
  };
}
