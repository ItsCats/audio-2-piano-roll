/**
 * Automatic sync of a hands video added to a song: the video's sound (streamed, 8 kHz) against the
 * song's original recording when it has one, else against its notes. The math runs in a worker.
 */
import type { Song } from '../music/types';
import { getAudio } from '../storage/db';
import { decodeToRate } from '../transcription/decode';
import { videoSound8k } from './media';
import { SYNC_SR, findOffset, type SyncInput, type SyncResult } from './sync';
import type { HandVideoSync } from './types';

export const SYNC_FAILED = 'Couldn’t find where your video lines up with the song. Line it up with the slider.';

function runMath(input: SyncInput, signal?: AbortSignal): Promise<SyncResult> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./syncWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return Promise.resolve(findOffset(input));
  const w = worker;
  return new Promise<SyncResult>((resolve, reject) => {
    const stop = () => {
      w.terminate();
      reject(new DOMException('Canceled', 'AbortError'));
    };
    signal?.addEventListener('abort', stop, { once: true });
    w.onmessage = (e: MessageEvent<{ ok: boolean; result?: SyncResult; error?: string }>) => {
      signal?.removeEventListener('abort', stop);
      w.terminate();
      if (e.data.ok && e.data.result) resolve(e.data.result);
      else reject(new Error(e.data.error ?? SYNC_FAILED));
    };
    w.onerror = () => {
      signal?.removeEventListener('abort', stop);
      w.terminate();
      // no module workers (old browsers): on this thread
      try {
        resolve(findOffset(input));
      } catch (err) {
        reject(err);
      }
    };
    w.postMessage(input, [input.video.buffer as ArrayBuffer, ...(input.ref.kind === 'audio' ? [input.ref.samples.buffer as ArrayBuffer] : [])]);
  });
}

/** What the sync will compare the video with. */
export function syncReference(song: Pick<Song, 'hasAudio' | 'handVideo'>): 'original' | 'notes' {
  return song.hasAudio && song.handVideo?.store !== 'audio' ? 'original' : 'notes';
}

export async function autoSync(
  song: Song,
  video: Blob,
  opts: { signal?: AbortSignal; onProgress?: (f: number, what: string) => void; useOriginal?: boolean } = {},
): Promise<{ offset: number; sync: HandVideoSync }> {
  const { signal } = opts;
  const report = opts.onProgress ?? (() => {});
  report(0, 'Reading your video’s sound');
  const vid = await videoSound8k(video, { signal, onProgress: (f) => report(0.7 * f, 'Reading your video’s sound') });
  let ref: SyncInput['ref'] = { kind: 'notes', notes: song.base.map((n) => ({ start: n.start, vel: n.vel })) };
  if ((opts.useOriginal ?? true) && syncReference(song) === 'original') {
    report(0.72, 'Reading the song’s recording');
    try {
      const blob = await getAudio(song.id);
      if (blob) {
        const buf = await decodeToRate(blob, SYNC_SR);
        const mono = new Float32Array(buf.length);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
        }
        ref = { kind: 'audio', samples: mono, sr: SYNC_SR };
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      /* the notes will do */
    }
  }
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  if (ref.kind === 'notes' && ref.notes.length < 4) throw new Error(SYNC_FAILED);
  report(0.8, 'Finding where your video lines up with the song');
  const r = await runMath({ video: vid.samples, sr: vid.sr, t0: vid.t0, ref }, signal);
  report(1, 'Done');
  return {
    offset: r.offset,
    sync: { method: r.method, found: r.offset, confidence: Math.round(r.ratio * 100) / 100, level: r.level, ...(r.drift ? { drift: true } : {}) },
  };
}

/** "Your video starts 3.42 s before the song." */
export function offsetSentence(offset: number): string {
  const s = Math.abs(offset);
  if (s < 0.005) return 'Your video starts with the song.';
  return `Your video starts ${s.toFixed(2)} s ${offset > 0 ? 'before' : 'after'} the song.`;
}
