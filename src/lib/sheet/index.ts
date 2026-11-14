/**
 * Sheet music for an arrangement (pure TS, no DOM): `buildSheet` → Score → `toMusicXml`.
 * The DOM parts (lazy OpenSheetMusicDisplay rendering, PDF) are in render.ts and pdf.ts.
 */
import type { Arrangement, Difficulty, Song } from '../music/types';
import { buildScore } from './score';
import { sheetTempo } from './grid';
import type { Score } from './types';
import { toMusicXml } from './musicxml';

export { buildScore } from './score';
export { toMusicXml, CREDIT_LINE } from './musicxml';
export { systemBreaks, lineBudget } from './layout';
export type { Score } from './types';

/**
 * The last few Scores, by arrangement object. A small list, not a WeakMap: undo history keeps every
 * edited arrangement alive, and a Score cached for each would stay with it (a few MB per edit on a
 * long song).
 */
const CACHE_SIZE = 6;
const cache = new Map<Arrangement, { tempo: Song['tempo']; key: Song['key']; duration: number; sheet: Song['sheet']; score: Score }>();
const tempoCache = new WeakMap<Song['tempo'], Song['tempo']>();

/**
 * The beat grid the sheet is written on (grid.ts sheetTempo), memoised per song tempo. A song read
 * from sheet music keeps its written grid: its bars are exact, never re-estimated from the notes.
 */
export function songSheetTempo(song: Song): Song['tempo'] {
  if (song.transcription?.method === 'score-file') return song.tempo;
  let t = tempoCache.get(song.tempo);
  if (!t) tempoCache.set(song.tempo, (t = sheetTempo(song.tempo, song.base ?? [], song.duration)));
  return t;
}

/** The Score of a song's arrangement, memoised by arrangement object (edits make a new one) plus tempo and key. */
export function buildSheet(song: Song, difficulty: Difficulty): Score {
  const arr = song.arrangements[difficulty];
  const hit = cache.get(arr);
  if (hit && hit.tempo === song.tempo && hit.key === song.key && hit.duration === song.duration && hit.sheet === song.sheet) {
    cache.delete(arr);
    cache.set(arr, hit);
    return hit.score;
  }
  const score = buildScore({
    notes: arr.notes,
    tempo: songSheetTempo(song),
    key: song.key,
    duration: song.duration,
    level: difficulty,
    lock: song.sheet?.grid,
    bars: song.sheet?.bars,
    keys: song.sheet?.keys,
    meters: song.sheet?.meters,
    tempos: song.sheet?.tempos,
    marks: arr.marks,
    pedal: arr.showPedal ? arr.pedal : undefined,
  });
  cache.delete(arr);
  cache.set(arr, { tempo: song.tempo, key: song.key, duration: song.duration, sheet: song.sheet, score });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return score;
}

/** A complete MusicXML file of the arrangement (with title / composer / credit line). */
export function songMusicXml(song: Song, difficulty: Difficulty): string {
  return toMusicXml(buildSheet(song, difficulty), { title: song.title, artist: song.artist, credits: true });
}
