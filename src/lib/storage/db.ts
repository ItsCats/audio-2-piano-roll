/**
 * Local-first persistence (IndexedDB). Nothing leaves the browser unless the user enables
 * the optional processing backend. Large binary data (original audio, model posteriors,
 * background media) is stored separately from song metadata.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Song, SongSource, SongSummary } from '../music/types';
import type { StoredPosteriors } from '../transcription/posteriors';
import { bumpNoteIds } from '../music/cleanup';
import { sanitizeHandVideo } from '../handcam/calibration';

export interface MediaItem {
  id: string;
  name: string;
  type: string;
  kind: 'image' | 'video';
  blob: Blob;
  createdAt: number;
}

/**
 * An import that has started but not finished, written before any decoding so that a tab the
 * browser kills mid-analysis (out of memory, most often on phones) does not lose the recording.
 * Deleted when the import finishes, fails or is cancelled.
 */
export interface PendingImport {
  id: string;
  title: string;
  artist?: string;
  /** song source kind ('audio' file, 'capture' microphone recording, 'youtube' tab capture) */
  kind: SongSource['kind'];
  source: SongSource;
  /** the audio to import again; absent for files too large to keep a copy of */
  blob?: Blob;
  mimeType: string;
  fileName: string;
  /** Date.now() when the import started */
  startedAt: number;
  /** detection preset at the time */
  presetId: string;
  separate: boolean;
  /**
   * Sheet-music reader imports (kind 'score'): what to read again. A PDF is `blob` with the chosen
   * pages; photos are `photos` (in page order; `blob` is the first one) with their page corners.
   * Absent in older records and for audio.
   */
  sheet?: PendingSheet;
}

export type PendingSheet = (
  | { kind: 'pdf'; pages: number[] }
  | { kind: 'photo'; photos: { blob: Blob; name: string; quad: [number, number][] | null }[] }
) & {
  /** this read is already a retry after a crash, in the slower low-memory mode (one thread) */
  lowMemory?: boolean;
};

interface PVSchema extends DBSchema {
  songs: { key: string; value: Song };
  summaries: { key: string; value: SongSummary; indexes: { updatedAt: number } };
  audio: { key: string; value: { blob: Blob; name: string; type: string } };
  posteriors: { key: string; value: StoredPosteriors };
  media: { key: string; value: MediaItem };
  pending: { key: string; value: PendingImport };
  /** hands videos added to a song after its import (Song.handVideo, store 'handcam'), keyed by song id */
  handcam: { key: string; value: StoredHandVideo };
}

/** A hands video file (lib/handcam). */
export interface StoredHandVideo {
  blob: Blob;
  name: string;
  type: string;
  size: number;
  addedAt: number;
}

/** Name and version of the IndexedDB database (exported for the upgrade test). */
// database name predates the Piano2Vision rename; changing it would orphan users' libraries
export const DB_NAME = 'pianovision';
/** 1: songs, summaries, audio, posteriors, media. 2: + pending (interrupted imports). 3: + handcam (hands videos). */
export const DB_VERSION = 3;

let dbp: Promise<IDBPDatabase<PVSchema>> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB<PVSchema>(DB_NAME, DB_VERSION, {
      // each step only adds what that version introduced: existing stores and data are kept
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('songs', { keyPath: 'id' });
          const s = d.createObjectStore('summaries', { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
          d.createObjectStore('audio');
          d.createObjectStore('posteriors');
          d.createObjectStore('media', { keyPath: 'id' });
        }
        if (oldVersion < 2 && !d.objectStoreNames.contains('pending')) {
          d.createObjectStore('pending', { keyPath: 'id' });
        }
        if (oldVersion < 3 && !d.objectStoreNames.contains('handcam')) {
          d.createObjectStore('handcam');
        }
      },
      // another tab still has the database open at the old version. A tab of this version closes it in
      // its `blocking` handler, but a tab still running the previous version of the app has no such
      // handler: every read and write here waits until that tab is closed or reloaded, so say so
      blocked() {
        setBlocked(true);
      },
      // a newer version of the app in another tab wants to upgrade: let it, reopen on next use
      blocking() {
        void dbp?.then((d) => d.close());
        dbp = null;
      },
      terminated() {
        dbp = null;
      },
    });
    dbp.then(
      () => setBlocked(false),
      () => {
        setBlocked(false);
        dbp = null;
      },
    );
  }
  return dbp;
}

let blockedNow = false;
const blockedListeners = new Set<(blocked: boolean) => void>();
function setBlocked(b: boolean) {
  if (b === blockedNow) return;
  blockedNow = b;
  for (const l of blockedListeners) l(b);
}

/**
 * Be told while the database can't be opened because another tab (an older version of the app)
 * keeps it open at the old version (the listener is called at once if that is the case now).
 * Returns the unsubscribe function.
 */
export function watchDatabaseBlocked(listener: (blocked: boolean) => void): () => void {
  blockedListeners.add(listener);
  if (blockedNow) listener(true);
  return () => blockedListeners.delete(listener);
}

/** Close the connection (tests). */
export async function closeDb(): Promise<void> {
  const p = dbp;
  dbp = null;
  if (p) (await p).close();
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

/**
 * `pendingId`: the interrupted-import record of the import that produced this song, deleted in the
 * same transaction, so a tab killed while saving leaves either the record (song not saved) or the
 * song (record gone), never both (which would offer to import the song a second time).
 */
export async function saveSong(song: Song, opts: { pendingId?: string } = {}): Promise<void> {
  const d = await db();
  if (opts.pendingId) {
    const tx = d.transaction(['songs', 'summaries', 'pending'], 'readwrite');
    await Promise.all([
      tx.objectStore('songs').put(song),
      tx.objectStore('summaries').put(summarize(song)),
      tx.objectStore('pending').delete(opts.pendingId),
      tx.done,
    ]);
    return;
  }
  const tx = d.transaction(['songs', 'summaries'], 'readwrite');
  await Promise.all([tx.objectStore('songs').put(song), tx.objectStore('summaries').put(summarize(song)), tx.done]);
}

export async function getSong(id: string): Promise<Song | undefined> {
  const song = await (await db()).get('songs', id);
  if (song) {
    bumpNoteIds(song.base);
    for (const a of Object.values(song.arrangements)) bumpNoteIds(a.notes);
    // a damaged hands video entry is repaired or dropped (it never breaks an export)
    if ('handVideo' in song) {
      const hv = sanitizeHandVideo(song.handVideo);
      // the song's own recording as its video: only while the recording is kept
      if (hv && (hv.store === 'handcam' || song.hasAudio)) song.handVideo = hv;
      else delete song.handVideo;
    }
  }
  return song;
}

export async function listSummaries(): Promise<SongSummary[]> {
  const all = await (await db()).getAll('summaries');
  return all.sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt));
}

export async function deleteSong(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['songs', 'summaries', 'audio', 'posteriors', 'handcam'], 'readwrite');
  await Promise.all([
    tx.objectStore('songs').delete(id),
    tx.objectStore('summaries').delete(id),
    tx.objectStore('audio').delete(id),
    tx.objectStore('posteriors').delete(id),
    tx.objectStore('handcam').delete(id),
    tx.done,
  ]);
}

export async function saveAudio(id: string, blob: Blob, name: string): Promise<void> {
  await (await db()).put('audio', { blob, name, type: blob.type }, id);
}
export async function getAudio(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('audio', id))?.blob;
}
/** Whether the song's original recording is still stored (without reading it). */
export async function hasStoredAudio(id: string): Promise<boolean> {
  return (await (await db()).getKey('audio', id)) !== undefined;
}
/** The song's hands video file: its original recording (imported from the video) or one added later. */
export async function getHandVideoBlob(song: Pick<Song, 'id' | 'handVideo'>): Promise<Blob | undefined> {
  const hv = song.handVideo;
  if (!hv) return undefined;
  if (hv.store === 'audio') return getAudio(song.id);
  return (await (await db()).get('handcam', song.id))?.blob;
}
export async function saveHandVideoBlob(songId: string, blob: Blob, name: string): Promise<void> {
  await (await db()).put('handcam', { blob, name, type: blob.type, size: blob.size, addedAt: Date.now() }, songId);
}
export async function deleteHandVideoBlob(songId: string): Promise<void> {
  await (await db()).delete('handcam', songId);
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

export async function savePending(p: PendingImport): Promise<void> {
  await (await db()).put('pending', p);
}
export async function getPending(id: string): Promise<PendingImport | undefined> {
  return (await db()).get('pending', id);
}
export async function listPending(): Promise<PendingImport[]> {
  return (await (await db()).getAll('pending')).sort((a, b) => b.startedAt - a.startedAt);
}
/**
 * `startedAt`: delete the record only if it is still the one written then (an import resumed under
 * the same id has rewritten it, and the cleanup of an earlier run must not delete the newer one).
 */
export async function deletePending(id: string, startedAt?: number): Promise<void> {
  const d = await db();
  if (startedAt === undefined) {
    await d.delete('pending', id);
    return;
  }
  const tx = d.transaction('pending', 'readwrite');
  const cur = await tx.store.get(id);
  if (cur && cur.startedAt === startedAt) await tx.store.delete(id);
  await tx.done;
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
