import type { Difficulty, Song } from '../music/types';
import { exportMidi } from '../music/midi';
import { renderOfflineChunks } from '../audio/offlineRender';
import { WavWriter } from '../audio/wav';
import type { AudioSettings } from '../audio/types';
import { saveSong, newId } from '../storage/db';
import { bumpNoteIds } from '../music/cleanup';

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'piano2vision';
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadMidi(song: Song, difficulty: Difficulty): void {
  const arr = song.arrangements[difficulty];
  const bytes = exportMidi(arr.notes, arr.pedal, song.tempo, song.title);
  downloadBlob(new Blob([bytes as BlobPart], { type: 'audio/midi' }), `${safeFileName(song.title)} (${difficulty}).mid`);
}

/** MusicXML of the arrangement (opens in MuseScore, Sibelius, Finale…). */
export async function downloadMusicXml(song: Song, difficulty: Difficulty): Promise<void> {
  const { songMusicXml } = await import('../sheet');
  const xml = songMusicXml(song, difficulty);
  downloadBlob(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${safeFileName(song.title)} (${difficulty}).musicxml`);
}

export async function renderWav(
  song: Song,
  difficulty: Difficulty,
  settings: AudioSettings,
  opts: { start?: number; end?: number; rate?: number; onProgress?: (f: number) => void; signal?: AbortSignal } = {},
): Promise<Blob> {
  const arr = song.arrangements[difficulty];
  const sr = 44100;
  const wav = new WavWriter(sr);
  await renderOfflineChunks(
    {
      notes: arr.notes,
      pedal: arr.pedal,
      settings,
      start: opts.start ?? 0,
      end: opts.end ?? song.duration,
      rate: opts.rate ?? 1,
      sampleRate: sr,
      fadeOut: 1.5,
      onProgress: opts.onProgress,
      signal: opts.signal,
    },
    (buf, from, to) => wav.append(buf, from, to),
  );
  return wav.finish();
}

/** Portable project file (notes, arrangements, tempo — not the original audio). */
export function exportProject(song: Song): void {
  // the format id predates the Piano2Vision name; kept so older project files still import
  const data = { format: 'pianovision-project', version: 1, exportedAt: new Date().toISOString(), song: { ...song, thumbnail: undefined } };
  downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${safeFileName(song.title)}.piano2vision.json`);
}

export async function importProject(file: File): Promise<Song> {
  if (file.size > 50 * 1024 * 1024) throw new Error('Project file is too large.');
  const data = JSON.parse(await file.text());
  if (data?.format !== 'pianovision-project' || !data.song?.arrangements) throw new Error('Not a Piano2Vision project file.');
  const song: Song = { ...data.song, id: newId(), hasAudio: false, hasPosteriors: false, updatedAt: Date.now() };
  for (const d of ['easy', 'medium', 'hard'] as const) {
    if (!Array.isArray(song.arrangements[d]?.notes)) throw new Error('Project file is missing arrangement data.');
    bumpNoteIds(song.arrangements[d].notes);
  }
  bumpNoteIds(song.base);
  await saveSong(song);
  return song;
}
