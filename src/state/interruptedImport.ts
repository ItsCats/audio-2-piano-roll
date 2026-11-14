/**
 * Imports a killed tab left behind. An audio import writes its audio and options to IndexedDB before
 * decoding (importStore.ts persistPending) and deletes them when it ends. A record that is still there
 * on the next page load, from before that load and not locked by another open tab, means the tab died
 * mid-import (on phones almost always because the browser ran out of memory and reloaded the page).
 */
import { deletePending, getPending, listPending, type PendingImport } from '../lib/storage/db';
import { PENDING_LOCK_PREFIX } from './importStore';
import { quickStaysAfterCrash, readerOf } from '../lib/omr/readers';
import { isMemoryConstrained, pageDeviceInfo, type DeviceInfo } from '../lib/transcription/backendChoice';

/** When this document started loading (records written by this page are newer). */
export const PAGE_LOADED_AT = typeof performance !== 'undefined' && performance.timeOrigin ? Math.round(performance.timeOrigin) : Date.now();

/**
 * The interrupted import to tell the user about: the newest record written before this page loaded
 * whose import is not running in another tab (that tab holds its Web Lock).
 */
export function pickInterrupted(records: PendingImport[], pageLoadedAt: number, heldLocks: ReadonlySet<string>): PendingImport | null {
  const candidates = records.filter((r) => r.startedAt < pageLoadedAt && !heldLocks.has(PENDING_LOCK_PREFIX + r.id));
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
}

const isRecording = (r: Pick<PendingImport, 'kind'>) => r.kind === 'capture' || r.kind === 'youtube';

export interface InterruptedNotice {
  title: string;
  body: string;
  /** Try again is possible (the audio was kept) */
  canRetry: boolean;
  /** offer "Save recording" (microphone and tab recordings) */
  canSave: boolean;
  /** the Try again button's label when it does something other than the same again */
  retryLabel?: string;
  /**
   * a second retry button (the accurate sheet-music reader on a computer: read once more with it, in
   * its low-memory mode; importStore resumePending(rec, { reader: 'accurate' }))
   */
  retryAccurateLabel?: string;
}

/**
 * Plain-language notice for an interrupted import (no technical terms: most of these are phones).
 * For a high-accuracy piano model run, `retryWith` (importStore resumeTranscriber) says which model
 * Try again will use; for a "Full song + piano model" run, `blendAgain` (importStore resumeBlend)
 * whether Try again adds the piano model again.
 */
export function interruptedNotice(
  rec: Pick<PendingImport, 'title' | 'kind' | 'blob'> & { transcriber?: string; pianoBlend?: boolean; sheet?: PendingImport['sheet']; source?: { sheetReader?: unknown } },
  retryWith?: 'basic-pitch' | 'piano-specialist',
  device: DeviceInfo | undefined = pageDeviceInfo(),
  blendAgain?: boolean,
): InterruptedNotice {
  // a sheet-music reader (Accurate or Quick): a PDF or photos, read again from the kept copy
  if (rec.kind === 'score') {
    const kept = !!rec.blob && !!rec.sheet;
    const n = rec.sheet ? (rec.sheet.kind === 'pdf' ? rec.sheet.pages.length : rec.sheet.photos.length) : 0;
    const what = rec.sheet?.kind === 'photo' ? (n > 1 ? 'Your photos were kept.' : 'Your photo was kept.') : 'Your file was kept.';
    if (readerOf(rec.source) === 'accurate') {
      // the accurate reader needs about 1 GB more memory: offer the quick reader (importStore
      // resumePending), and on a computer also the accurate one again in its low-memory mode (one crash
      // there may just have been a reload)
      const again = rec.sheet?.lowMemory;
      const offerAccurate = kept && !again && !(device && isMemoryConstrained(device));
      const remember = quickStaysAfterCrash(again, device) ? ' The Quick reader is then picked for next time (you can switch back on the Sheet music tab).' : '';
      const why = again ? 'stopped again, even in the slower mode that uses less memory' : 'was interrupted — it probably needed more memory than this device had free';
      return {
        title: again ? 'Reading the sheet music stopped again' : 'Your last import was interrupted',
        body: `Reading “${rec.title}” with the Accurate reader ${why}. ${
          !kept
            ? 'Choose the file again and pick the Quick reader, which needs much less memory.'
            : offerAccurate
              ? `${what} Read it with the Quick reader, which needs much less memory, or close other tabs and apps and try the Accurate reader again in a slower mode that uses less memory.`
              : `${what} The Quick reader needs much less memory: read it with that one, after closing other tabs and apps.${remember}`
        }`,
        canRetry: kept,
        canSave: false,
        retryLabel: 'Use the Quick reader',
        ...(offerAccurate ? { retryAccurateLabel: 'Try the Accurate reader again' } : {}),
      };
    }
    if (rec.sheet?.lowMemory) {
      // it already stopped once and was read again in the low-memory mode: do not offer the same again
      return {
        title: 'Reading the sheet music stopped again',
        body: `Reading “${rec.title}” stopped again, even in the slower mode that uses less memory. This device does not have enough free memory for it right now. Try ${n > 1 ? 'one page at a time' : 'again after restarting the browser'}, or use a computer.`,
        canRetry: false,
        canSave: false,
      };
    }
    const advice = kept
      ? ' Try again reads it once more in a slower mode that uses less memory. Close other tabs and apps first.'
      : n > 1
        ? ' Reading sheet music needs a lot of memory: close other tabs and apps, or read fewer pages at a time.'
        : ' Reading sheet music needs a lot of memory: close other tabs and apps first.';
    return {
      title: 'Your last import was interrupted',
      body: `Reading “${rec.title}” was interrupted — your browser probably ran out of memory. ${kept ? what : 'Choose the file again to try once more.'}${advice}`,
      canRetry: kept,
      canSave: false,
    };
  }
  const kept = !!rec.blob;
  const what = isRecording(rec) ? 'Your recording was kept.' : kept ? 'Your file was kept.' : 'Choose the file again to try once more.';
  const model =
    kept && rec.transcriber === 'piano-specialist' && retryWith
      ? retryWith === 'basic-pitch'
        ? ' It was using the high-accuracy piano model, which needs a lot of memory: Try again uses the normal model.'
        : ' Try again uses the high-accuracy piano model again; close other tabs first.'
      : kept && rec.pianoBlend && blendAgain !== undefined
        ? blendAgain
          ? ' Try again adds the piano model again; close other tabs first.'
          : ' It was adding the piano model, which needs a lot of memory: Try again uses the standard Full song result.'
        : '';
  return {
    title: 'Your last import was interrupted',
    body: `Your last import (“${rec.title}”) was interrupted — your browser probably ran out of memory. ${what}${model}`,
    canRetry: kept,
    canSave: kept && isRecording(rec),
  };
}

/** Names of the Web Locks held right now (empty without the API). */
async function heldLockNames(): Promise<Set<string>> {
  try {
    const q = await navigator.locks?.query();
    return new Set((q?.held ?? []).map((l) => l.name ?? '').filter(Boolean));
  } catch {
    return new Set();
  }
}

/** The interrupted import to report on this page load, if any. Never throws. */
export async function findInterruptedImport(pageLoadedAt = PAGE_LOADED_AT): Promise<PendingImport | null> {
  try {
    const records = await listPending();
    if (!records.length) return null;
    return pickInterrupted(records, pageLoadedAt, await heldLockNames());
  } catch (err) {
    console.warn('[import] could not check for an interrupted import', err);
    return null;
  }
}

/**
 * Whether the record can still be resumed from this tab: not discarded, and not already resumed in
 * another open tab since the notice was shown (two tabs resuming it would import the song twice).
 * Never throws (when it can't tell, it says yes).
 */
export async function stillInterrupted(id: string): Promise<boolean> {
  try {
    if (!(await getPending(id))) return false;
  } catch {
    return true;
  }
  return !(await heldLockNames()).has(PENDING_LOCK_PREFIX + id);
}

export async function discardInterrupted(id: string): Promise<void> {
  try {
    await deletePending(id);
  } catch (err) {
    console.warn('[import] could not delete the interrupted import', err);
  }
}
