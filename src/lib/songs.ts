import type { Difficulty, Note, PedalRange, Song, SongSource, TempoInfo, TranscriptionInfo, KeyInfo } from './music/types';
import { generateAllArrangements, generateArrangement } from './music/difficulty';
import { detectKey } from './music/theory';
import { songDuration } from './music/cleanup';
import { newId } from './storage/db';
import type { ParsedMidi } from './music/midi';
import { bachPreludeDemo } from './music/demo';

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
    arrangements: generateAllArrangements(input.notes, input.pedal, input.tempo, duration),
    thumbnail: makeThumbnail(input.notes, duration),
    hasAudio: input.hasAudio,
    hasPosteriors: input.hasPosteriors,
  };
}

export function songFromMidi(parsed: ParsedMidi, fileName: string, fileSize: number): Song {
  return buildSong({
    title: parsed.title || titleFromFileName(fileName),
    source: { kind: 'midi', fileName, fileSize, mimeType: 'audio/midi' },
    notes: parsed.notes,
    pedal: parsed.pedal,
    tempo: parsed.tempo,
    duration: parsed.duration,
    transcription: { method: 'midi-file', estimated: false, warnings: parsed.warnings },
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
    transcription: { method: 'demo', estimated: false, warnings: [] },
    hasAudio: false,
    hasPosteriors: false,
  });
}

export function regenerate(song: Song, which: Difficulty[]): Song {
  const arrangements = { ...song.arrangements };
  for (const d of which) arrangements[d] = generateArrangement(d, song.base, song.basePedal, song.tempo, song.duration);
  return { ...song, arrangements, updatedAt: Date.now() };
}

export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';
}
