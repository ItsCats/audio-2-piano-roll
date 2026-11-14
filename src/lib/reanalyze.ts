/**
 * Whether a song can be analyzed again from its stored recording ("Analyze again" in the Studio), and
 * if not, why (the dialog explains it and offers importing the recording again).
 */
import type { Song } from './music/types';

export type ReimportRoute = '/import' | '/import?tab=record' | '/import?tab=computer';

export type ReanalyzeSupport =
  | { ok: true }
  | {
      ok: false;
      /**
       * 'demo': the built-in demo (no Analyze again at all). 'exact': notes from a MIDI file or sheet
       * music (no recording). 'not-saved': the recording was never stored with this song (opened from
       * a project file, or it didn't fit in the browser's storage). 'cleared': it was stored, but this
       * browser no longer has it.
       */
      kind: 'demo' | 'exact' | 'not-saved' | 'cleared';
      /** where to import the recording again (songs from audio) */
      reimport?: ReimportRoute;
    };

const reimportFor = (kind: Song['source']['kind']): ReimportRoute => (kind === 'capture' ? '/import?tab=record' : kind === 'youtube' ? '/import?tab=computer' : '/import');

/** `stored`: the recording is in this browser's storage now (useStoredOriginal). */
export function reanalyzeSupport(song: Pick<Song, 'source' | 'hasAudio' | 'transcription'>, stored: boolean): ReanalyzeSupport {
  const kind = song.source.kind;
  if (kind === 'demo' || song.transcription.method === 'demo') return { ok: false, kind: 'demo' };
  if (kind === 'midi' || kind === 'score' || song.transcription.method === 'midi-file' || song.transcription.method === 'score-file') return { ok: false, kind: 'exact' };
  if (!song.hasAudio) return { ok: false, kind: 'not-saved', reimport: reimportFor(kind) };
  if (!stored) return { ok: false, kind: 'cleared', reimport: reimportFor(kind) };
  return { ok: true };
}
