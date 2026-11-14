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
export function arrangementOptions(song: { transcription: TranscriptionInfo; autoPedal?: boolean }): ArrangementOptions {
  const t = song.transcription;
  return { handsFromScore: t.handsFromScore === true || t.method === 'demo', autoPedal: song.autoPedal === true && isAudioSong(song) };
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

interface BuildInput {
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
 * - 'played': notes end when their key is let go (asPlayed); the pedal heard in the recording becomes
 *   `basePedal` and the automatic pedal goes off, so Medium and Hard play it. From an older song
 *   (notes as heard, no `noteLength`) this gives exactly what a fresh import gives.
 * - 'heard': notes last as long as they ring under that pedal (asHeard); the pedal stays, so the
 *   sound does not change, only what is drawn, written and practiced.
 */
export function withNoteLength(song: Song, to: NoteLength): Song {
  let base: Note[];
  let basePedal = song.basePedal;
  let auto = song.autoPedal;
  if (to === 'played') {
    const r = asPlayed(song.base);
    base = r.notes;
    basePedal = r.pedal;
    auto = false;
  } else {
    base = noteLengthOf(song) === 'heard' ? song.base : asHeard(song.base, song.basePedal);
  }
  const thumbnail = makeThumbnail(base, song.duration) ?? song.thumbnail;
  const next: Song = { ...song, base, basePedal, noteLength: to, ...(thumbnail ? { thumbnail } : {}), updatedAt: Date.now() };
  if (auto === undefined) delete next.autoPedal;
  else next.autoPedal = auto;
  const all = generateAllArrangements(base, basePedal, song.tempo, song.duration, arrangementOptions(next));
  const arrangements = {} as Record<Difficulty, Arrangement>;
  for (const d of DIFFICULTIES) arrangements[d] = keepMarkings(song.arrangements[d], all[d]);
  next.arrangements = arrangements;
  return next;
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
