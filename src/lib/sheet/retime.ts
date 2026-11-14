/**
 * Tempo marks that change the playback speed (songs without a recording or hands video): from a
 * position on, the music is re-timed to a new tempo up to the next re-timed tempo mark (after it
 * the old spacing is kept). One mapping of song seconds, f(t), is applied to every time field of
 * the song, so positions on the sheet never change: toPos_before(t) = toPos_after(f(t)).
 */
import type { Note, PedalRange, SheetGridLock, SheetTempo, Song, TempoInfo, TempoUnit } from '../music/types';
import { tempoQpm } from '../music/beats';
import { gridFromLock, resolveMeter } from './grid';
import { TEMPO_UNIT_Q } from './score';
import { DIV } from './types';

/** Whether tempo marks may change the playback speed: not with a recording or a hands video to stay in sync with. */
export const canRetime = (song: Pick<Song, 'hasAudio' | 'handVideo'>): boolean => !song.hasAudio && !song.handVideo;

/**
 * Songs whose notes follow a written tempo, not a recording: sheet music (files and PDF / photo
 * reads), MIDI files and the demo, without a hands video. Setting their tempo re-times the whole
 * song (scaleSongTempo); songs from audio keep a beat grid over the recording instead.
 */
export const followsWrittenTempo = (song: Pick<Song, 'hasAudio' | 'handVideo' | 'transcription'>): boolean =>
  canRetime(song) && ['score-file', 'midi-file', 'demo'].includes(song.transcription?.method);

/** A re-timed tempo mark at the very start (it sets the opening speed). */
const startMark = (song: Pick<Song, 'sheet'>): SheetTempo | undefined => song.sheet?.tempos?.find((t) => t.pos === 0 && t.retimed);

/** Quarter notes per minute the song starts at: a re-timed tempo mark at the start, else the song's tempo. */
export function songStartQpm(song: Pick<Song, 'sheet' | 'tempo' | 'transcription' | 'hasAudio' | 'handVideo'>): number {
  const m0 = canRetime(song) ? startMark(song) : undefined;
  if (m0) return m0.bpm * TEMPO_UNIT_Q[m0.unit];
  return tempoQpm(song.tempo, song.transcription?.method === 'midi-file');
}

/** The felt beat of a meter, as the sheet writes its tempo marks (a dotted quarter in 6/8, a half in 2/2). */
export function meterUnit(beatsPerBar: number, beatUnit: 2 | 4 | 8): TempoUnit {
  if (beatUnit === 8) return beatsPerBar % 3 === 0 ? 'q.' : 'e';
  return beatUnit === 2 ? 'h' : 'q';
}

/** The note value the song's tempo is shown in: the start mark's, else the opening meter's beat. */
export function songTempoUnit(song: Pick<Song, 'sheet' | 'tempo'>): TempoUnit {
  const m0 = startMark(song);
  if (m0) return m0.unit;
  const meter0 = song.sheet?.meters?.find((m) => m.pos === 0);
  if (meter0) return meterUnit(meter0.beatsPerBar, meter0.beatUnit);
  const g = song.sheet?.grid;
  if (g) return meterUnit(g.beatsPerBar, g.beatUnit);
  const m = resolveMeter(song.tempo);
  return meterUnit(m.beatsPerBar, m.beatUnit);
}

/** `bpm` of a TempoInfo (beats of its beat unit per minute, one decimal) for a quarter tempo. */
function bpmOf(tempo: TempoInfo, qpm: number): number {
  const { beatUnit } = resolveMeter(tempo);
  return Math.round(qpm * (beatUnit / 4) * 10) / 10;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clampBpm = (x: number) => Math.max(20, Math.min(400, x));

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
  const tempo: TempoInfo = { ...song.tempo, beats: song.tempo.beats.map(f) };
  if (pos0In <= 0) {
    // from the start: the song's tempo is the new one (count-in, the Notes tab, MIDI files)
    tempo.bpm = bpmOf(song.tempo, qpm);
    tempo.qpm = qpm;
    tempo.from = 'set';
    delete tempo.fromText;
    if (!Number.isFinite(pos1)) grid.bpm = qpm / qPerBeat;
  }
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

/**
 * Sets the speed the song starts at, `bpm` beats of `unit` per minute (songs without a recording or
 * hands video: canRetime), by scaling every time in the song by one factor k = old / new: every
 * level (edited or not: notes, pedal, pins, articulation lengths), the notes the levels are made
 * from, the beat grid, the length and the sheet's locked grid. Positions on the sheet never change,
 * so fingering, markings, key / time changes and pins stay where they are, and tempo changes later
 * in the piece (written ones, fermatas, re-timed tempo marks) keep their proportions. Exact and
 * reversible (setting the old tempo again gives the same seconds back, up to rounding error).
 *
 * `mark`: also put a re-timed tempo mark at the start (the sheet editor's tempo mark on bar 1; the
 * song must have its grid locked). An existing re-timed mark at the start always takes the new
 * value, in the new unit.
 */
export function scaleSongTempo(song: Song, bpm: number, unit: TempoUnit, opts: { mark?: boolean; text?: string } = {}): { patch: RetimePatch; k: number } {
  const qpm = bpm * TEMPO_UNIT_Q[unit];
  const old = songStartQpm(song);
  if (!canRetime(song)) throw new Error('scaleSongTempo: this song follows a recording');
  if (!(qpm > 0 && Number.isFinite(qpm)) || !(old > 0 && Number.isFinite(old))) throw new Error('scaleSongTempo: no tempo');
  const k = old / qpm;
  const f = (t: number) => t * k;
  const mapNote = (n: Note): Note => {
    const start = f(n.start);
    const dur = f(n.dur);
    const out: Note = { ...n, start, dur };
    if (n.pin) out.pin = n.pin.t === n.start && n.pin.d === n.dur ? { ...n.pin, t: start, d: dur } : { ...n.pin };
    if (n.artBase?.dur !== undefined) out.artBase = { ...n.artBase, dur: f(n.artBase.dur) };
    return out;
  };
  const mapPedal = (p: PedalRange): PedalRange => ({ start: f(p.start), end: f(p.end) });
  const arrangements = { ...song.arrangements };
  for (const lv of Object.keys(arrangements) as (keyof Song['arrangements'])[]) {
    const a = arrangements[lv];
    arrangements[lv] = { ...a, notes: a.notes.map(mapNote), pedal: a.pedal.map(mapPedal) };
  }
  const tempo: TempoInfo = { ...song.tempo, beats: song.tempo.beats.map(f), bpm: bpmOf(song.tempo, qpm), qpm, from: 'set' };
  delete tempo.fromText;
  let sheet = song.sheet;
  if (sheet) {
    const text = opts.text?.trim();
    let tempos = (sheet.tempos ?? []).map((t): SheetTempo => {
      if (!t.retimed) return t;
      if (t.pos === 0) return { pos: 0, bpm, unit, ...(text ? { text } : t.text && !opts.mark ? { text: t.text } : {}), retimed: true };
      return { ...t, bpm: clampBpm(round2(t.bpm / k)) };
    });
    if (opts.mark) {
      tempos = tempos.filter((t) => t.pos !== 0 || t.retimed);
      if (!tempos.some((t) => t.pos === 0)) tempos.unshift({ pos: 0, bpm, unit, ...(text ? { text } : {}), retimed: true });
    }
    sheet = { ...sheet, grid: { ...sheet.grid, beats: sheet.grid.beats.map(f), bpm: sheet.grid.bpm / k } };
    if (tempos.length) sheet.tempos = tempos;
    else delete sheet.tempos;
  } else if (opts.mark) throw new Error('scaleSongTempo: a tempo mark needs the locked grid');
  return {
    patch: {
      arrangements,
      base: song.base.map(mapNote),
      basePedal: song.basePedal.map(mapPedal),
      tempo,
      duration: f(song.duration),
      sheet,
    },
    k,
  };
}
