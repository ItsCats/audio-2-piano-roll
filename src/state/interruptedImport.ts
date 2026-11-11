/**
 * Imports a killed tab left behind. An audio import writes its audio and options to IndexedDB before
 * decoding (importStore.ts persistPending) and deletes them when it ends. A record that is still there
 * on the next page load, from before that load and not locked by another open tab, means the tab died
 * mid-import (on phones almost always because the browser ran out of memory and reloaded the page).
 */
import { deletePending, getPending, listPending, type PendingImport } from '../lib/storage/db';
import { PENDING_LOCK_PREFIX } from './importStore';

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
}

/** Plain-language notice for an interrupted import (no technical terms: most of these are phones). */
export function interruptedNotice(rec: Pick<PendingImport, 'title' | 'kind' | 'blob'>): InterruptedNotice {
  const kept = !!rec.blob;
  const what = isRecording(rec) ? 'Your recording was kept.' : kept ? 'Your file was kept.' : 'Choose the file again to try once more.';
  return {
    title: 'Your last import was interrupted',
    body: `Your last import (“${rec.title}”) was interrupted — your browser probably ran out of memory. ${what}`,
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
