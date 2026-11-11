/**
 * Local-first persistence (IndexedDB). Nothing leaves the browser unless the user enables
 * the optional processing backend. Large binary data (original audio, model posteriors,
 * background media) is stored separately from song metadata.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Song, SongSummary } from '../music/types';
import type { StoredPosteriors } from '../transcription/posteriors';
import { bumpNoteIds } from '../music/cleanup';

export interface MediaItem {
  id: string;
  name: string;
  type: string;
  kind: 'image' | 'video';
  blob: Blob;
  createdAt: number;
}

interface PVSchema extends DBSchema {
  songs: { key: string; value: Song };
  summaries: { key: string; value: SongSummary; indexes: { updatedAt: number } };
  audio: { key: string; value: { blob: Blob; name: string; type: string } };
  posteriors: { key: string; value: StoredPosteriors };
  media: { key: string; value: MediaItem };
}

let dbp: Promise<IDBPDatabase<PVSchema>> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB<PVSchema>('pianovision', 1, {
      upgrade(d) {
        d.createObjectStore('songs', { keyPath: 'id' });
        const s = d.createObjectStore('summaries', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        d.createObjectStore('audio');
        d.createObjectStore('posteriors');
        d.createObjectStore('media', { keyPath: 'id' });
      },
    });
  }
  return dbp;
}

export function summarize(song: Song): SongSummary {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
    lastPlayedAt: song.lastPlayedAt,
    duration: song.duration,
    source: song.source,
    thumbnail: song.thumbnail,
    favorite: song.favorite,
    noteCount: song.base.length,
    bpm: song.tempo.bpm,
    keyName: song.key?.name,
    estimated: song.transcription.estimated,
  };
}

export async function saveSong(song: Song): Promise<void> {
  const d = await db();
  const tx = d.transaction(['songs', 'summaries'], 'readwrite');
  await Promise.all([tx.objectStore('songs').put(song), tx.objectStore('summaries').put(summarize(song)), tx.done]);
}

export async function getSong(id: string): Promise<Song | undefined> {
  const song = await (await db()).get('songs', id);
  if (song) {
    bumpNoteIds(song.base);
    for (const a of Object.values(song.arrangements)) bumpNoteIds(a.notes);
  }
  return song;
}

export async function listSummaries(): Promise<SongSummary[]> {
  const all = await (await db()).getAll('summaries');
  return all.sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt));
}

export async function deleteSong(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['songs', 'summaries', 'audio', 'posteriors'], 'readwrite');
  await Promise.all([
    tx.objectStore('songs').delete(id),
    tx.objectStore('summaries').delete(id),
    tx.objectStore('audio').delete(id),
    tx.objectStore('posteriors').delete(id),
    tx.done,
  ]);
}

export async function saveAudio(id: string, blob: Blob, name: string): Promise<void> {
  await (await db()).put('audio', { blob, name, type: blob.type }, id);
}
export async function getAudio(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('audio', id))?.blob;
}
export async function savePosteriors(id: string, p: StoredPosteriors): Promise<void> {
  await (await db()).put('posteriors', p, id);
}
export async function getPosteriors(id: string): Promise<StoredPosteriors | undefined> {
  return (await db()).get('posteriors', id);
}

export async function saveMedia(item: MediaItem): Promise<void> {
  await (await db()).put('media', item);
}
export async function getMedia(id: string): Promise<MediaItem | undefined> {
  return (await db()).get('media', id);
}
export async function listMedia(): Promise<MediaItem[]> {
  return (await (await db()).getAll('media')).sort((a, b) => b.createdAt - a.createdAt);
}
export async function deleteMedia(id: string): Promise<void> {
  await (await db()).delete('media', id);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
