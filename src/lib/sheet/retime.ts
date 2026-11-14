/**
 * Tempo marks that change the playback speed (songs without a recording or hands video): from a
 * position on, the music is re-timed to a new tempo up to the next re-timed tempo mark (after it
 * the old spacing is kept). One mapping of song seconds, f(t), is applied to every time field of
 * the song, so positions on the sheet never change: toPos_before(t) = toPos_after(f(t)).
 */
import type { Note, PedalRange, SheetGridLock, Song } from '../music/types';
import { gridFromLock } from './grid';
import { DIV } from './types';

/** Whether tempo marks may change the playback speed: not with a recording or a hands video to stay in sync with. */
export const canRetime = (song: Pick<Song, 'hasAudio' | 'handVideo'>): boolean => !song.hasAudio && !song.handVideo;

export type RetimePatch = Pick<Song, 'arrangements' | 'base' | 'basePedal' | 'tempo' | 'duration' | 'sheet'>;

/**
 * Re-times the song from position `pos0` (divisions on the locked grid; snapped down to a beat of
 * the grid) at `qpm` quarter notes per minute. The song must have its grid locked (song.sheet).
 */
export function retime(song: Song, pos0In: number, qpm: number): { patch: RetimePatch; f: (t: number) => number } {
  const sheet = song.sheet;
  if (!sheet) throw new Error('retime needs the locked grid');
  const lock = sheet.grid;
  const qPerBeat = 4 / lock.beatUnit;
  const old = gridFromLock(lock, song.tempo.source);
  // beat i sits at position ((i − db) · qPerBeat − originQ) · DIV
  const posOfBeat = (i: number) => ((i - lock.db) * qPerBeat - lock.originQ) * DIV;
  const beatOfPos = (p: number) => (p / DIV + lock.originQ) / qPerBeat + lock.db;
  const pos0 = posOfBeat(Math.floor(beatOfPos(Math.max(0, pos0In)) + 1e-9));
  const T0 = old.posToTime(pos0);
  const later = (sheet.tempos ?? []).filter((x) => x.retimed && x.pos > pos0In).map((x) => x.pos);
  const pos1 = later.length ? Math.min(...later) : Infinity;
  const secPerDiv = 60 / qpm / DIV;
  const T1new = Number.isFinite(pos1) ? T0 + (pos1 - pos0) * secPerDiv : Infinity;
  const T1old = Number.isFinite(pos1) ? old.posToTime(pos1) : Infinity;
  const newTime = (p: number) => (p <= pos0 ? old.posToTime(p) : p <= pos1 ? T0 + (p - pos0) * secPerDiv : T1new + (old.posToTime(p) - T1old));
  const f = (t: number) => (t <= T0 ? t : newTime(old.toPos(t)));

  // new beats: the same beat positions at their new times (extended past the end of the song)
  const endT = f(song.duration);
  const iFirst = Math.min(0, Math.floor(beatOfPos(0)) - 1);
  const beats: number[] = [];
  for (let i = iFirst; ; i++) {
    const tb = i < 0 || i >= lock.beats.length || posOfBeat(i) > pos0 ? newTime(posOfBeat(i)) : lock.beats[i];
    beats.push(tb);
    if (i >= lock.beats.length - 1 && tb > endT + 4 * (60 / qpm) * qPerBeat * 8 && beats.length >= 2) break;
    if (beats.length >= 200000) break;
  }
  // the beats run past the end, so the extrapolation tempo stays (it is also the sheet's first tempo mark)
  const grid: SheetGridLock = { ...lock, beats, db: lock.db - iFirst };

  const mapNote = (n: Note): Note => {
    const start = f(n.start);
    const dur = Math.max(0.01, f(n.start + n.dur) - start);
    const out: Note = { ...n, start, dur };
    if (n.pin) out.pin = n.pin.t === n.start && n.pin.d === n.dur ? { ...n.pin, t: start, d: dur } : { ...n.pin };
    if (n.artBase?.dur !== undefined) out.artBase = { ...n.artBase, dur: Math.max(0.01, f(n.start + n.artBase.dur) - start) };
    return out;
  };
  const mapPedal = (p: PedalRange): PedalRange => ({ start: f(p.start), end: f(p.end) });
  const arrangements = { ...song.arrangements };
  for (const k of Object.keys(arrangements) as (keyof Song['arrangements'])[]) {
    const a = arrangements[k];
    arrangements[k] = { ...a, notes: a.notes.map(mapNote), pedal: a.pedal.map(mapPedal) };
  }
  const tempo = { ...song.tempo, beats: song.tempo.beats.map(f) };
  return {
    patch: {
      arrangements,
      base: song.base.map(mapNote),
      basePedal: song.basePedal.map(mapPedal),
      tempo,
      duration: f(song.duration),
      sheet: { ...sheet, grid },
    },
    f,
  };
}
