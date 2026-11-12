/**
 * Sheet music for an arrangement (pure TS, no DOM): `buildSheet` → Score → `toMusicXml`.
 * The DOM parts (lazy OpenSheetMusicDisplay rendering, PDF) are in render.ts and pdf.ts.
 */
import type { Arrangement, Difficulty, Song } from '../music/types';
import { buildScore } from './score';
import type { Score } from './types';
import { toMusicXml } from './musicxml';

export { buildScore } from './score';
export { toMusicXml, CREDIT_LINE } from './musicxml';
export { systemBreaks, lineBudget } from './layout';
export type { Score } from './types';

const cache = new WeakMap<Arrangement, { tempo: Song['tempo']; key: Song['key']; duration: number; score: Score }>();

/** The Score of a song's arrangement, memoised by arrangement object (edits make a new one) plus tempo and key. */
export function buildSheet(song: Song, difficulty: Difficulty): Score {
  const arr = song.arrangements[difficulty];
  const hit = cache.get(arr);
  if (hit && hit.tempo === song.tempo && hit.key === song.key && hit.duration === song.duration) return hit.score;
  const score = buildScore({ notes: arr.notes, tempo: song.tempo, key: song.key, duration: song.duration, level: difficulty });
  cache.set(arr, { tempo: song.tempo, key: song.key, duration: song.duration, score });
  return score;
}

/** A complete MusicXML file of the arrangement (with title / composer / credit line). */
export function songMusicXml(song: Song, difficulty: Difficulty): string {
  return toMusicXml(buildSheet(song, difficulty), { title: song.title, artist: song.artist, credits: true });
}
