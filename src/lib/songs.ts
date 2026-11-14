import { DIFFICULTIES, type Arrangement, type Difficulty, type Note, type NoteLength, type PedalRange, type Song, type SongSource, type TempoInfo, type TranscriptionInfo, type KeyInfo } from './music/types';
import { generateAllArrangements, generateArrangement, type ArrangementOptions } from './music/difficulty';
import { autoPedal, isAudioSong } from './music/autoPedal';
import { detectKey } from './music/theory';
import { songDuration } from './music/cleanup';
import { newId } from './storage/db';
import type { ParsedMidi } from './music/midi';
import type { ParsedScore } from './score';
import { bachPreludeDemo } from './music/demo';
import { carryMarks } from './sheet/carry';
import { asHeard, asPlayed } from './music/noteLength';
import type { TranscriptionResult } from './transcription/pipeline';

/** A compact piano-roll overview image used as the song's thumbnail. */
export function makeThumbnail(notes: Note[], duration: number, colors = { R: '#4f9dff', L: '#f5a524' }): string | undefined {
  if (typeof document === 'undefined' || !notes.length) return undefined;
  const w = 320;
  const h = 180;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return undefined;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#11131c');
  g.addColorStop(1, '#0a0a0e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  lo -= 2;
  hi += 2;
  const span = Math.min(duration, 90); // first 90 s
  for (const n of notes) {
    if (n.start > span) break;
    const x = (n.start / span) * w;
    const nw = Math.max(1.5, (n.dur / span) * w);
    const y = h - ((n.midi - lo) / (hi - lo)) * h;
    ctx.fillStyle = n.hand === 'L' ? colors.L : colors.R;
    ctx.globalAlpha = 0.45 + n.vel * 0.55;
    ctx.fillRect(x, y - 1.5, nw, 3);
  }
  ctx.globalAlpha = 1;
  return c.toDataURL('image/webp', 0.8);
}

/**
 * Arrangement options for a song (Hard keeps hands that come from the score; songs from audio
 * with the automatic pedal on get pedal on Medium and Hard).
 */
export function arrangementOptions(song: { transcription: TranscriptionInfo; autoPedal?: boolean; noteLength?: NoteLength }): ArrangementOptions {
  const t = song.transcription;
  return {
    handsFromScore: t.handsFromScore === true || t.method === 'demo',
    autoPedal: song.autoPedal === true && isAudioSong(song),
    ...(song.noteLength === 'played' ? { easyAsHeard: true } : {}),
  };
}

/**
 * Turns the automatic pedal of a song from audio on or off. Medium and Hard get pedal derived
 * from their current notes (hand edits are kept); off clears it. Easy has none either way.
 */
export function withAutoPedal(song: Song, on: boolean, opts?: { replaceEdited?: boolean }): Song {
  const arrangements = { ...song.arrangements };
  for (const d of DIFFICULTIES) {
    if (d === 'easy') continue;
    const a = arrangements[d];
    // pedal edited on the sheet is kept (the caller asks first: pedalEditedLevels)
    if (a.pedalEdited && !opts?.replaceEdited) continue;
    if (a.pedalEdited) {
      const { pedalEdited: _p, ...rest } = a;
      void _p;
      arrangements[d] = { ...rest, pedal: on ? autoPedal(a.notes, song.tempo, song.duration > 0 ? song.duration : Infinity) : song.basePedal.map((p) => ({ ...p })) };
      continue;
    }
    arrangements[d] = { ...a, pedal: on ? autoPedal(a.notes, song.tempo, song.duration > 0 ? song.duration : Infinity) : song.basePedal.map((p) => ({ ...p })) };
  }
  return { ...song, autoPedal: on, arrangements, updatedAt: Date.now() };
}

/** Levels whose pedal was edited on the sheet (automatic pedal and regenerating ask before replacing it). */
export const pedalEditedLevels = (song: Song): Difficulty[] => DIFFICULTIES.filter((d) => song.arrangements[d].pedalEdited);

/**
 * Easy and Medium rebuilt from the current Hard notes (with Hard's edits), and Hard's markings
 * carried over to them (lib/sheet/marks.ts carryMarks). Sheet positions are not copied: the derived
 * notes are written on their own level's grid.
 */
export function easyMediumFromHard(song: Song): Song {
  const hardArr = song.arrangements.hard;
  const hard = hardArr.notes.map(({ pin: _pin, finger: _f, art: _a, artBase: _b, ...n }) => (void _pin, void _f, void _a, void _b, n));
  const all = generateAllArrangements(hard, song.basePedal, song.tempo, song.duration, arrangementOptions(song));
  return { ...song, arrangements: { ...song.arrangements, easy: carryMarks(hardArr, all.easy), medium: carryMarks(hardArr, all.medium) }, updatedAt: Date.now() };
}

export interface BuildInput {
  title: string;
  artist?: string;
  source: SongSource;
  notes: Note[];
  pedal: PedalRange[];
  tempo: TempoInfo;
  duration: number;
  key?: KeyInfo;
  transcription: TranscriptionInfo;
  hasAudio: boolean;
  hasPosteriors: boolean;
  /** songs from audio: sustain pedal derived from the notes on Medium and Hard (Song.autoPedal) */
  autoPedal?: boolean;
  /** the high-accuracy piano model's notes: their note length (Song.noteLength) */
  noteLength?: NoteLength;
}

export function buildSong(input: BuildInput): Song {
  const now = Date.now();
  const duration = Math.max(input.duration, songDuration(input.notes));
  return {
    id: newId(),
    title: input.title,
    artist: input.artist,
    createdAt: now,
    updatedAt: now,
    duration,
    source: input.source,
    tempo: input.tempo,
    key: input.key ?? detectKey(input.notes),
    transcription: input.transcription,
    base: input.notes,
    basePedal: input.pedal,
    arrangements: generateAllArrangements(input.notes, input.pedal, input.tempo, duration, arrangementOptions(input)),
    thumbnail: makeThumbnail(input.notes, duration),
    hasAudio: input.hasAudio,
    hasPosteriors: input.hasPosteriors,
    ...(input.autoPedal !== undefined && isAudioSong(input) ? { autoPedal: input.autoPedal } : {}),
    ...(input.noteLength && hasNoteLength(input) ? { noteLength: input.noteLength } : {}),
  };
}

/** Songs whose note length can be switched: the high-accuracy piano model's (music/noteLength.ts). */
export function hasNoteLength(song: { transcription: TranscriptionInfo }): boolean {
  return song.transcription.method === 'piano-specialist';
}

/** The song's note length; songs made before it existed have the notes as heard. */
export function noteLengthOf(song: Pick<Song, 'noteLength'>): NoteLength {
  return song.noteLength ?? 'heard';
}

/**
 * Switches a high-accuracy piano model song's note length (Song.noteLength). Every level is rebuilt
 * from the detected notes, like setting the tempo; the sheet's locked grid is kept, and each level's
 * fingering, markings and pedal edited on the sheet are carried over to the rebuilt notes (onsets do
 * not move), while note fixes are replaced (the caller asks first: levels marked `edited`).
 * - 'played': notes end when their key is let go; the pedal heard in the recording is `basePedal`, so
 *   Medium and Hard play it. Back from 'heard', the notes and pedal kept at that switch
 *   (`notesAsPlayed`) come back exactly, and the automatic pedal stays as it is. From an older song
 *   (notes as heard, never 'played') they are worked out (asPlayed), exactly what a fresh import gives,
 *   and the automatic pedal goes off (it does not know where the pianist pedaled).
 * - 'heard': notes last as long as they ring under that pedal (asHeard); the pedal stays, so the
 *   sound does not change, only what is drawn, written and practiced.
 */
export function withNoteLength(song: Song, to: NoteLength): Song {
  let base: Note[];
  let basePedal = song.basePedal;
  let auto = song.autoPedal;
  let kept: Song['notesAsPlayed'];
  if (to === 'played') {
    const back = song.notesAsPlayed && sameNotesAsPlayed(song.notesAsPlayed, song.base, song.basePedal) ? song.notesAsPlayed : null;
    if (back) {
      base = back.base;
      basePedal = back.pedal;
    } else {
      const r = asPlayed(song.base);
      base = r.notes;
      basePedal = r.pedal;
      auto = false;
    }
  } else if (noteLengthOf(song) === 'heard') {
    base = song.base;
  } else {
    base = asHeard(song.base, song.basePedal);
    kept = { base: song.base, pedal: song.basePedal };
  }
  const thumbnail = makeThumbnail(base, song.duration) ?? song.thumbnail;
  const next: Song = { ...song, base, basePedal, noteLength: to, ...(thumbnail ? { thumbnail } : {}), updatedAt: Date.now() };
  if (auto === undefined) delete next.autoPedal;
  else next.autoPedal = auto;
  if (kept) next.notesAsPlayed = kept;
  else delete next.notesAsPlayed;
  const all = generateAllArrangements(base, basePedal, song.tempo, song.duration, arrangementOptions(next));
  const arrangements = {} as Record<Difficulty, Arrangement>;
  for (const d of DIFFICULTIES) arrangements[d] = keepMarkings(song.arrangements[d], all[d]);
  next.arrangements = arrangements;
  return next;
}

/** The kept as-played notes still belong to the notes as heard (same notes, and they ring as these do). */
function sameNotesAsPlayed(kept: { base: Note[]; pedal: PedalRange[] }, heard: Note[], pedal: PedalRange[]): boolean {
  if (kept.base.length !== heard.length || kept.pedal.length !== pedal.length) return false;
  if (kept.pedal.some((p, i) => p.start !== pedal[i].start || p.end !== pedal[i].end)) return false;
  const rung = asHeard(kept.base, kept.pedal);
  return rung.every((x, i) => {
    const y = heard[i];
    return x.id === y.id && x.midi === y.midi && x.hand === y.hand && Math.abs(x.start - y.start) < 1e-6 && Math.abs(x.dur - y.dur) < 0.002;
  });
}

/** A rebuilt level with the old one's fingering, markings and sheet pedal (carryMarks); still `edited` when any came along. */
function keepMarkings(old: Arrangement, rebuilt: Arrangement): Arrangement {
  const out = carryMarks(old, rebuilt);
  const carried = !!out.marks?.length || !!out.pedalEdited || out.notes.some((n) => n.finger || n.art?.length);
  return carried && old.edited ? { ...out, edited: true } : out;
}

export function songFromMidi(parsed: ParsedMidi, fileName: string, fileSize: number): Song {
  return buildSong({
    title: parsed.title || titleFromFileName(fileName),
    source: { kind: 'midi', fileName, fileSize, mimeType: 'audio/midi' },
    notes: parsed.notes,
    pedal: parsed.pedal,
    tempo: parsed.tempo,
    duration: parsed.duration,
    transcription: { method: 'midi-file', estimated: false, warnings: parsed.warnings, handsFromScore: parsed.handsKnown },
    hasAudio: false,
    hasPosteriors: false,
  });
}

/**
 * A Song from sheet music (lib/score: a score file, or MusicXML from PDF / photo recognition).
 * Hard is the piece exactly as written; Easy and Medium are generated like for MIDI files.
 */
export function songFromScore(parsed: ParsedScore, source: SongSource & { kind: 'score' }): Song {
  return buildSong({
    title: parsed.title || (source.fileName ? titleFromFileName(source.fileName) : 'Sheet music'),
    artist: parsed.composer,
    source,
    notes: parsed.notes,
    pedal: parsed.pedal,
    tempo: parsed.tempo,
    duration: parsed.duration,
    key: parsed.key,
    transcription: { method: 'score-file', estimated: false, warnings: parsed.warnings, handsFromScore: parsed.handsKnown },
    hasAudio: false,
    hasPosteriors: false,
  });
}

export function demoSong(): Song {
  const d = bachPreludeDemo();
  return buildSong({
    title: 'Prelude in C major, BWV 846',
    artist: 'J. S. Bach',
    source: { kind: 'demo' },
    notes: d.notes,
    pedal: d.pedal,
    tempo: d.tempo,
    duration: d.duration,
    transcription: { method: 'demo', estimated: false, warnings: [], handsFromScore: true },
    hasAudio: false,
    hasPosteriors: false,
  });
}

/**
 * What buildSong takes for a transcription result (an import and "Analyze again" build their songs
 * the same way): the result's notes, pedal, tempo, key and info; the automatic pedal on Medium and
 * Hard unless the result has the pedal heard in the recording (the high-accuracy piano model), whose
 * notes are then "as played". `tempo`: use this tempo instead of the result's (a tempo set by hand).
 */
export function songInputFromResult(
  result: Pick<TranscriptionResult, 'notes' | 'pedal' | 'tempo' | 'duration' | 'key' | 'info' | 'posteriors'>,
  meta: { title: string; artist?: string; source: SongSource; tempo?: TempoInfo },
): BuildInput {
  return {
    title: meta.title,
    artist: meta.artist,
    source: meta.source,
    notes: result.notes,
    pedal: result.pedal ?? [],
    tempo: meta.tempo ?? result.tempo,
    duration: result.duration,
    key: result.key,
    transcription: result.info,
    hasAudio: true,
    // re-detection works on Basic Pitch posteriors only (the piano specialist's outputs are not stored)
    hasPosteriors: !!result.posteriors,
    // Medium and Hard: sustain pedal derived from the notes (switch in the Sound panel)
    autoPedal: !result.pedal,
    ...(result.pedal ? { noteLength: 'played' as const } : {}),
  };
}

// ---------------------------------------------------------------- "Analyze again" (the song's recording analyzed once more)

/**
 * The song fields an analysis produces: "Analyze again" replaces them (the old values are kept as the
 * song's other version, lib/storage/db.ts), and switching versions swaps them.
 */
export const ANALYSIS_KEYS = ['base', 'basePedal', 'duration', 'tempo', 'key', 'transcription', 'arrangements', 'thumbnail', 'hasPosteriors', 'autoPedal', 'noteLength'] as const satisfies readonly (keyof Song)[];
/** Fields that belong to one analysis's notes and go with them (the sheet's grid lock and marks, the kept as-played notes). */
export const REMOVED_KEYS = ['sheet', 'notesAsPlayed'] as const satisfies readonly (keyof Song)[];
/**
 * Everything else stays with the song: its id (and with it the title card text, which is stored by
 * song id), title, artist, source, dates, favorite, stored recording and hands video.
 */
export const KEPT_KEYS = ['id', 'title', 'artist', 'createdAt', 'updatedAt', 'lastPlayedAt', 'source', 'hasAudio', 'favorite', 'handVideo'] as const satisfies readonly (keyof Song)[];

type AnalysisKey = (typeof ANALYSIS_KEYS)[number] | (typeof REMOVED_KEYS)[number];

/** `target` with the analysis of `from` (ANALYSIS_KEYS and REMOVED_KEYS; the ones `from` lacks are removed). */
export function withAnalysisOf(target: Song, from: Song): Song {
  const out = { ...target } as Record<string, unknown>;
  for (const k of [...ANALYSIS_KEYS, ...REMOVED_KEYS] as AnalysisKey[]) {
    if (from[k] === undefined) delete out[k];
    else out[k] = from[k];
  }
  return out as unknown as Song;
}

/**
 * The song after "Analyze again": the new result's notes on every level, with the song itself kept
 * (KEPT_KEYS). A tempo set by hand is kept (the levels are built on it, as Re-detect does); the sheet's
 * grid lock and marks and the kept as-played notes go (they belong to the old notes).
 */
export function songFromReanalysis(old: Song, result: Pick<TranscriptionResult, 'notes' | 'pedal' | 'tempo' | 'duration' | 'key' | 'info' | 'posteriors'>, now: number): Song {
  const fresh = buildSong(songInputFromResult(result, { title: old.title, artist: old.artist, source: old.source, tempo: old.tempo.source === 'manual' ? old.tempo : undefined }));
  // (the levels were built with the new analysis's own options: arrangementOptions depends only on analysis keys)
  const next = withAnalysisOf({ ...old, updatedAt: now }, fresh);
  return next;
}

/** Levels in the order the loss text names them. */
const LEVELS_HARD_FIRST: Difficulty[] = ['hard', 'medium', 'easy'];
export const levelName = (d: Difficulty): string => d.charAt(0).toUpperCase() + d.slice(1);

/** "A", "A and B", "A, B and C" */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A level has work of the user's on it: note fixes, fingering or markings. */
function levelEdited(a: Arrangement): boolean {
  return a.edited || !!a.marks?.length || a.notes.some((n) => n.finger || n.art?.length);
}

export interface LostWork {
  /** levels with note fixes, fingering or markings (Hard first) */
  levels: Difficulty[];
  /** sheet edits: the locked grid and key/time/tempo marks */
  sheet: boolean;
  /** levels whose pedal was edited on the sheet */
  pedal: Difficulty[];
  /** the note length was switched to "As heard" */
  heard: boolean;
}

/** What "Analyze again" replaces that the user made. */
export function lostWork(song: Song): LostWork {
  const pedal = pedalEditedLevels(song);
  return {
    levels: LEVELS_HARD_FIRST.filter((d) => levelEdited(song.arrangements[d])),
    sheet: !!song.sheet,
    pedal: LEVELS_HARD_FIRST.filter((d) => pedal.includes(d)),
    heard: song.noteLength === 'heard' || !!song.notesAsPlayed,
  };
}

/** The confirmation text of "Analyze again" (`hasUndo`: there are steps to undo now). */
export function lossText(lost: LostWork, hasUndo: boolean): string {
  const parts: string[] = [];
  if (lost.levels.length) parts.push(`fixes on ${joinAnd(lost.levels.map(levelName))}`);
  if (lost.sheet) parts.push('sheet edits and key/time/tempo marks');
  if (lost.pedal.length) parts.push(`pedal changes on ${joinAnd(lost.pedal.map(levelName))}`);
  if (lost.heard) parts.push('“As heard” note lengths');
  const out = ['This replaces the notes on every level.'];
  if (parts.length) out.push(`Your ${joinAnd(parts)} will be removed.`);
  if (hasUndo) out.push('Undo history is cleared.');
  out.push('You can go back to the old notes afterward.');
  return out.join(' ');
}

export type ResetExtra = 'fingering' | 'markings' | 'pedal changes';

export interface ResetResult {
  song: Song;
  /** the level differs from the detected notes (resetting it changes something) */
  changed: boolean;
  /** notes that differ (the larger of: notes only in the old level, notes only in the detected one) */
  noteChanges: number;
  /** other differences the reset removes */
  extras: ResetExtra[];
  /** the level was edited by the user (note fixes, or the pedal on the sheet) */
  userEdited: boolean;
}

const noteKey = (n: Note) => `${n.midi}|${Math.round(n.start * 1000)}|${Math.round(n.dur * 1000)}|${n.hand}|${Math.round(n.vel * 1000)}`;
const pedalKey = (p: PedalRange[]) => p.map((r) => `${Math.round(r.start * 1000)}-${Math.round(r.end * 1000)}`).join(',');

/**
 * "Reset {Level} to detected notes": level `d` built again from the detected notes (regenerate), and
 * what that changes compared with the level as it is (note ids and build times are ignored).
 */
export function resetLevel(song: Song, d: Difficulty): ResetResult {
  const next = regenerate(song, [d]);
  const old = song.arrangements[d];
  const fresh = next.arrangements[d];
  const count = new Map<string, number>();
  for (const n of old.notes) count.set(noteKey(n), (count.get(noteKey(n)) ?? 0) + 1);
  let onlyNew = 0;
  for (const n of fresh.notes) {
    const k = noteKey(n);
    const c = count.get(k) ?? 0;
    if (c > 0) count.set(k, c - 1);
    else onlyNew++;
  }
  let onlyOld = 0;
  for (const c of count.values()) onlyOld += c;
  const noteChanges = Math.max(onlyOld, onlyNew);
  const extras: ResetExtra[] = [];
  if (old.notes.some((n) => n.finger)) extras.push('fingering');
  if (old.marks?.length || old.notes.some((n) => n.art?.length)) extras.push('markings');
  if (old.pedalEdited || old.showPedal || pedalKey(old.pedal) !== pedalKey(fresh.pedal)) extras.push('pedal changes');
  return { song: next, changed: noteChanges > 0 || extras.length > 0, noteChanges, extras, userEdited: old.edited || !!old.pedalEdited };
}

/** The body of the toast after a level was reset (`r.changed`). */
export function resetToastBody(r: ResetResult, d: Difficulty): string {
  if (!r.userEdited && !r.extras.length) return `${levelName(d)} matches the detected notes again.`;
  const parts: string[] = [];
  if (r.noteChanges > 0) parts.push(r.noteChanges === 1 ? '1 note went back to the detected version.' : `${r.noteChanges} notes went back to the detected version.`);
  if (r.extras.length) {
    const what = joinAnd(r.extras);
    parts.push(`${what.charAt(0).toUpperCase()}${what.slice(1)} on this level ${r.extras.length === 1 && r.extras[0] !== 'pedal changes' && r.extras[0] !== 'markings' ? 'was' : 'were'} removed.`);
  }
  return parts.length ? parts.join(' ') : `${levelName(d)} matches the detected notes again.`;
}

export function regenerate(song: Song, which: Difficulty[]): Song {
  const arrangements = { ...song.arrangements };
  for (const d of which) arrangements[d] = generateArrangement(d, song.base, song.basePedal, song.tempo, song.duration, arrangementOptions(song));
  return { ...song, arrangements, updatedAt: Date.now() };
}

export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';
}
