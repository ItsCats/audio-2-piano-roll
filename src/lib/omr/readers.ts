/**
 * The two sheet-music readers the import screen offers, and which one is used:
 *
 *  - "accurate": homr (src/lib/omr/homr, AGPL-3.0-only), the default on computers. 93 MB download once,
 *    about a minute per page on a computer, ~1 GB of extra memory.
 *  - "quick": the Sheet Music Transformer (src/lib/omr/index.ts, Beta), the default on phones, tablets
 *    and devices reporting 4 GB of memory or less. 24 MB, faster, less accurate.
 *
 * This module is small on purpose (no reader code): the import store and the import screen use it
 * before either reader is loaded; each reader loads only when it is used.
 */
import { isMemoryConstrained, pageDeviceInfo, type DeviceInfo } from '../transcription/backendChoice';

export type SheetReaderId = 'accurate' | 'quick';

export const SHEET_READER_IDS: readonly SheetReaderId[] = ['accurate', 'quick'];

export const isSheetReaderId = (v: unknown): v is SheetReaderId => v === 'accurate' || v === 'quick';

/**
 * Plain-language facts shown next to each choice. `notesRight`: notes read with the right pitch in
 * the right order on clean printed pages, rounded down (src/lib/accuracyStats.ts SHEET_READER has the
 * measurements: accurate 0.98–1.00 on clean and engraved pages, quick 0.87–0.90 on new pages).
 */
export const SHEET_READER_INFO: Record<SheetReaderId, { name: string; short: string; notesRight: number; beta: boolean }> = {
  accurate: { name: 'Accurate reader', short: 'Accurate', notesRight: 98, beta: false },
  quick: { name: 'Quick reader', short: 'Quick', notesRight: 88, beta: true },
};

/** The reader used when the user has not picked one: accurate on computers, quick on phones, tablets and low-memory devices. */
export function defaultSheetReader(device: DeviceInfo | undefined = pageDeviceInfo()): SheetReaderId {
  return device && isMemoryConstrained(device) ? 'quick' : 'accurate';
}

/**
 * The reader for the next read: the user's remembered pick (import prefs `sheetReader`), else the
 * device default; a reader this browser cannot run gives way to the other one.
 */
export function sheetReaderChoice(
  pref: unknown,
  device: DeviceInfo | undefined = pageDeviceInfo(),
  available: Partial<Record<SheetReaderId, boolean>> = {},
): SheetReaderId {
  const want = isSheetReaderId(pref) ? pref : defaultSheetReader(device);
  if (available[want] === false) {
    const other: SheetReaderId = want === 'accurate' ? 'quick' : 'accurate';
    if (available[other] !== false) return other;
  }
  return want;
}

/** The accurate reader on a phone / low-memory device: may need more memory than the browser allows a tab. */
export function readerMayBeTooHeavy(id: SheetReaderId, device: DeviceInfo | undefined = pageDeviceInfo()): boolean {
  return id === 'accurate' && !!device && isMemoryConstrained(device);
}

/** The reader a song or an interrupted import was read with (records from before the choice: the quick reader, the only one then). */
export const readerOf = (src: { sheetReader?: unknown } | undefined | null): SheetReaderId => (isSheetReaderId(src?.sheetReader) ? src.sheetReader : 'quick');

/** "about a minute" for a number of seconds */
export function aboutTime(sec: number): string {
  if (sec < 45) return `about ${Math.max(10, Math.round(sec / 10) * 10)} seconds`;
  const m = Math.round(sec / 60);
  return m <= 1 ? 'about a minute' : `about ${m} minutes`;
}

/**
 * The line under a choice, e.g. "About 98% of notes right · 93 MB download once · about a minute per
 * page".
 */
export function readerFacts(id: SheetReaderId, s: { downloadMB: number; estSecondsPerPage: number }): string {
  return `About ${SHEET_READER_INFO[id].notesRight}% of notes right · ${s.downloadMB} MB download once · ${aboutTime(s.estSecondsPerPage)} per page`;
}
