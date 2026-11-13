/**
 * The choice between the two sheet-music readers (src/lib/omr/readers.ts): the device default, the
 * remembered pick in the import prefs (older prefs without it), which reader an import runs (both
 * readers mocked), and the crash recovery that offers the quick reader after the accurate one took the
 * tab down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/storage/db', () => ({
  saveSong: vi.fn(async () => undefined),
  saveAudio: vi.fn(async () => undefined),
  savePosteriors: vi.fn(async () => undefined),
  savePending: vi.fn(async () => undefined),
  deletePending: vi.fn(async () => undefined),
  listPending: vi.fn(async () => []),
  listSummaries: vi.fn(async () => []),
  requestPersistence: vi.fn(async () => true),
  newId: () => `id-${Math.random().toString(36).slice(2)}`,
}));

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;

const page = { w: 4, h: 4, d: new Uint8Array(16).fill(255) };
const quickRead = vi.fn(async (_pages: unknown, _opts: unknown) => ({ musicXml: XML, warnings: ['quick'], stats: { ms: 10 } }));
const accurateRead = vi.fn(async (_pages: unknown, _opts: unknown) => ({ musicXml: XML, warnings: ['accurate'], stats: { ms: 20 } }));
vi.mock('../../src/lib/omr', () => ({
  renderPdfPages: vi.fn(async () => [page]),
  loadPhoto: vi.fn(async () => ({ image: page, quad: null })),
  sheetReaderSupport: () => ({ available: true, recommended: true, downloadMB: 24, memoryMB: 800, estSecondsPerPage: 30, threads: 3, phone: false }),
  readSheetImages: (pages: unknown, opts: unknown) => quickRead(pages, opts),
}));
vi.mock('../../src/lib/omr/homr', () => ({
  homrReaderSupport: () => ({ available: true, recommended: true, downloadMB: 93, memoryMB: 1200, estSecondsPerPage: 45, threads: 3, phone: false, maxPages: 20 }),
  readSheetImages: (pages: unknown, opts: unknown) => accurateRead(pages, opts),
}));

const readers = await import('../../src/lib/omr/readers');
const { useImport, parsePrefs } = await import('../../src/state/importStore');
const { interruptedNotice } = await import('../../src/state/interruptedImport');
const { readByBeta } = await import('../../src/components/studio/SheetReaderNotice');
const { homrReaderSupport } = await import('../../src/lib/omr/homr/support');
const db = await import('../../src/lib/storage/db');

const desktop = { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', maxTouchPoints: 0, deviceMemory: 8 };
const iphone = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };
const ipadDesktopMode = { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', maxTouchPoints: 5 };
const android = { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36', maxTouchPoints: 5, mobile: true };
const smallLaptop = { ...desktop, deviceMemory: 4 };

describe('which reader by default', () => {
  it('accurate on computers, quick on phones, tablets and low-memory devices', () => {
    expect(readers.defaultSheetReader(desktop)).toBe('accurate');
    expect(readers.defaultSheetReader({ ua: desktop.ua })).toBe('accurate'); // no memory reported (Firefox, Safari)
    expect(readers.defaultSheetReader(iphone)).toBe('quick');
    expect(readers.defaultSheetReader(ipadDesktopMode)).toBe('quick');
    expect(readers.defaultSheetReader(android)).toBe('quick');
    expect(readers.defaultSheetReader(smallLaptop)).toBe('quick');
  });

  it('the remembered pick wins over the default, on phones too (opt-in)', () => {
    expect(readers.sheetReaderChoice('quick', desktop)).toBe('quick');
    expect(readers.sheetReaderChoice('accurate', iphone)).toBe('accurate');
    expect(readers.sheetReaderChoice(undefined, iphone)).toBe('quick');
    // anything else stored there is ignored
    expect(readers.sheetReaderChoice('homr', desktop)).toBe('accurate');
    expect(readers.sheetReaderChoice(42, iphone)).toBe('quick');
  });

  it('a reader this browser cannot run gives way to the other one', () => {
    expect(readers.sheetReaderChoice(undefined, desktop, { accurate: false })).toBe('quick');
    expect(readers.sheetReaderChoice('quick', desktop, { quick: false })).toBe('accurate');
    // neither: the choice stays (the screen explains why it cannot read)
    expect(readers.sheetReaderChoice('accurate', desktop, { accurate: false, quick: false })).toBe('accurate');
  });

  it('warns about the accurate reader only where memory is tight', () => {
    expect(readers.readerMayBeTooHeavy('accurate', iphone)).toBe(true);
    expect(readers.readerMayBeTooHeavy('accurate', smallLaptop)).toBe(true);
    expect(readers.readerMayBeTooHeavy('accurate', desktop)).toBe(false);
    expect(readers.readerMayBeTooHeavy('quick', iphone)).toBe(false);
  });

  it('describes each reader in plain words', () => {
    const accurate = homrReaderSupport(desktop, 3, { worker: true, simd: true });
    expect(accurate.downloadMB).toBe(93);
    expect(readers.readerFacts('accurate', accurate)).toBe('About 98% of notes right · 93 MB download once · about a minute per page');
    expect(readers.readerFacts('quick', { downloadMB: 24, estSecondsPerPage: 25 })).toBe('About 88% of notes right · 24 MB download once · about 30 seconds per page');
    // phones: one thread, about three times slower
    const phone = homrReaderSupport(iphone, 4, { worker: true, simd: true });
    expect(phone.threads).toBe(1);
    expect(readers.readerFacts('accurate', phone)).toMatch(/about 3 minutes per page$/);
    expect(readers.SHEET_READER_INFO.quick.beta).toBe(true);
    expect(readers.SHEET_READER_INFO.accurate.beta).toBe(false);
  });

  it('songs and records from before the choice count as read by the quick reader', () => {
    expect(readers.readerOf(undefined)).toBe('quick');
    expect(readers.readerOf({})).toBe('quick');
    expect(readers.readerOf({ sheetReader: 'accurate' })).toBe('accurate');
    const song = (sheetReader?: 'accurate' | 'quick') => ({ source: { kind: 'score' as const, reader: 'pdf' as const, ...(sheetReader ? { sheetReader } : {}) } });
    expect(readByBeta(song())).toBe(true);
    expect(readByBeta(song('quick'))).toBe(true);
    expect(readByBeta(song('accurate'))).toBe(false);
    expect(readByBeta({ source: { kind: 'score' } })).toBe(false); // a MusicXML file, not read
  });
});

describe('the pick in the import prefs', () => {
  it('older prefs (no sheetReader) still load, and the field is kept when valid', () => {
    expect(parsePrefs(JSON.stringify({ separate: { mix: true }, pianoModel: true }))).toEqual({ separate: { mix: true }, engine: {}, pianoModel: true });
    expect(parsePrefs(JSON.stringify({ separate: {}, sheetReader: 'quick' })).sheetReader).toBe('quick');
    expect(parsePrefs(JSON.stringify({ separate: {}, sheetReader: 'accurate' })).sheetReader).toBe('accurate');
    expect('sheetReader' in parsePrefs(JSON.stringify({ separate: {}, sheetReader: 'fast' }))).toBe(false);
    expect(parsePrefs(null)).toEqual({ separate: {} });
  });

  it('setSheetReaderPref keeps the other prefs', () => {
    useImport.setState({ prefs: { separate: { piano: false }, pianoModel: true } });
    useImport.getState().setSheetReaderPref('quick');
    expect(useImport.getState().prefs).toEqual({ separate: { piano: false }, pianoModel: true, sheetReader: 'quick' });
    useImport.getState().setSheetReaderPref('nonsense' as 'quick');
    expect(useImport.getState().prefs.sheetReader).toBe('quick');
  });
});

describe('importSheet runs the chosen reader', () => {
  beforeEach(() => {
    quickRead.mockClear();
    accurateRead.mockClear();
    vi.mocked(db.savePending).mockClear();
    useImport.setState({ job: null, controller: null, failed: null, prefs: { separate: {} } });
  });
  const pdf = () => ({ kind: 'pdf' as const, file: new Blob(['%PDF'], { type: 'application/pdf' }), fileName: 'prelude.pdf', pages: [1] });

  it('no pick on a computer: the accurate reader, recorded on the song and the crash-recovery record', async () => {
    const id = await useImport.getState().importSheet(pdf());
    expect(id).toBeTruthy();
    expect(accurateRead).toHaveBeenCalledTimes(1);
    expect(quickRead).not.toHaveBeenCalled();
    expect(useImport.getState().job?.sheetReader).toBe('accurate');
    expect(useImport.getState().job?.warnings).toContain('accurate');
    const saved = vi.mocked(db.saveSong).mock.calls.at(-1)?.[0];
    expect(saved?.source).toMatchObject({ kind: 'score', reader: 'pdf', sheetReader: 'accurate' });
    const pending = vi.mocked(db.savePending).mock.calls.at(-1)?.[0];
    expect(pending?.source).toMatchObject({ sheetReader: 'accurate' });
  });

  it('the remembered pick, or the one passed in', async () => {
    useImport.getState().setSheetReaderPref('quick');
    await useImport.getState().importSheet(pdf());
    expect(quickRead).toHaveBeenCalledTimes(1);
    expect(accurateRead).not.toHaveBeenCalled();
    expect(vi.mocked(db.saveSong).mock.calls.at(-1)?.[0].source.sheetReader).toBe('quick');
    await useImport.getState().importSheet(pdf(), { reader: 'accurate' });
    expect(accurateRead).toHaveBeenCalledTimes(1);
  });

  it('a failed accurate read offers the quick reader (and picks it for next time)', async () => {
    accurateRead.mockRejectedValueOnce(new Error('The sheet-music reader stopped.'));
    await useImport.getState().importSheet(pdf());
    const failed = useImport.getState().failed;
    expect(failed?.retryQuick).toBeTypeOf('function');
    await failed!.retryQuick!();
    expect(quickRead).toHaveBeenCalledTimes(1);
    expect(useImport.getState().prefs.sheetReader).toBe('quick');
    // a failed quick read has nothing else to offer
    quickRead.mockRejectedValueOnce(new Error('No music lines were found in this PDF.'));
    await useImport.getState().importSheet(pdf());
    expect(useImport.getState().failed?.retryQuick).toBeUndefined();
  });

  it('after the accurate reader took the tab down, Try again reads with the quick reader', async () => {
    const rec = {
      id: 'p1',
      title: 'Prelude',
      kind: 'score' as const,
      source: { kind: 'score' as const, reader: 'pdf' as const, sheetReader: 'accurate' as const, fileName: 'prelude.pdf' },
      blob: new Blob(['%PDF']),
      mimeType: 'application/pdf',
      fileName: 'prelude.pdf',
      separate: false,
      startedAt: 1,
      sheet: { kind: 'pdf' as const, pages: [1, 2] },
    };
    await useImport.getState().resumePending(rec);
    expect(accurateRead).not.toHaveBeenCalled();
    expect(quickRead).toHaveBeenCalledTimes(1);
    // the quick reader in its normal mode (it needs much less memory), not the one-thread retry
    expect(quickRead.mock.calls[0][1]).not.toMatchObject({ threads: 1 });
    expect(useImport.getState().prefs.sheetReader).toBe('quick');
    // a quick read that took the tab down: once more in the low-memory mode, still with the quick reader
    await useImport.getState().resumePending({ ...rec, source: { ...rec.source, sheetReader: 'quick' } });
    expect(accurateRead).not.toHaveBeenCalled();
    expect(quickRead.mock.calls[1][1]).toMatchObject({ threads: 1, release: true });
  });
});

describe('the interrupted-import notice', () => {
  const base = { title: 'Prelude', kind: 'score' as const, blob: new Blob(['x']), sheet: { kind: 'pdf' as const, pages: [1] } };

  it('after the accurate reader: offers the quick reader', () => {
    const n = interruptedNotice({ ...base, source: { sheetReader: 'accurate' } });
    expect(n.canRetry).toBe(true);
    expect(n.retryLabel).toBe('Use the Quick reader');
    expect(n.body).toMatch(/Accurate reader/);
    expect(n.body).toMatch(/Quick reader needs much less memory/);
    // the file was not kept: still names the quick reader
    const lost = interruptedNotice({ ...base, blob: undefined, sheet: undefined, source: { sheetReader: 'accurate' } });
    expect(lost.canRetry).toBe(false);
    expect(lost.body).toMatch(/pick the Quick reader/);
  });

  it('after the quick reader (and older records): the low-memory retry as before', () => {
    for (const source of [{ sheetReader: 'quick' }, {}, undefined]) {
      const n = interruptedNotice({ ...base, source });
      expect(n.retryLabel).toBeUndefined();
      expect(n.body).toMatch(/slower mode that uses less memory/);
    }
    const again = interruptedNotice({ ...base, sheet: { ...base.sheet, lowMemory: true }, source: { sheetReader: 'quick' } });
    expect(again.canRetry).toBe(false);
  });
});
