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
  pictureSize: vi.fn(async () => ({ w: 4, h: 4 })),
  loadPhoto: vi.fn(async () => ({ image: page, quad: null })),
  sheetReaderSupport: () => ({ available: true, recommended: true, downloadMB: 24, memoryMB: 800, estSecondsPerPage: 30, threads: 3, phone: false }),
  readSheetImages: (pages: unknown, opts: unknown) => quickRead(pages, opts),
}));
vi.mock('../../src/lib/omr/homr', () => ({
  homrReaderSupport: () => ({ available: true, recommended: true, downloadMB: 93, memoryMB: 1200, estSecondsPerPage: 45, threads: 3, phone: false, maxPages: 20 }),
  readSheetImages: (pages: unknown, opts: unknown) => accurateRead(pages, opts),
}));

const readers = await import('../../src/lib/omr/readers');
const { useImport, parsePrefs, photoDecodeSize } = await import('../../src/state/importStore');
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
    // a many-core computer (4 threads, ~40 s estimated): still "about a minute" (measured 32–73 s), not a
    // "40 seconds" that would sound like the quick reader
    const fast = homrReaderSupport(desktop, 4, { worker: true, simd: true });
    expect(fast.estSecondsPerPage).toBeLessThan(45);
    expect(readers.readerFacts('accurate', fast)).toMatch(/about a minute per page$/);
    expect(readers.readerTime('accurate', 3 * fast.estSecondsPerPage)).toBe('about 2 minutes');
    // the quick reader keeps its seconds (its phone estimate stays "about 50 seconds")
    expect(readers.readerTime('quick', 45)).toBe('about 50 seconds');
    expect(readers.readerTime('quick', 55)).toBe('about a minute');
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

  it('a failed accurate read offers the quick reader (just this once: the pick stays)', async () => {
    accurateRead.mockRejectedValueOnce(new Error('The sheet-music reader stopped.'));
    await useImport.getState().importSheet(pdf());
    const failed = useImport.getState().failed;
    expect(failed?.retryQuick).toBeTypeOf('function');
    await failed!.retryQuick!();
    expect(quickRead).toHaveBeenCalledTimes(1);
    expect(useImport.getState().prefs.sheetReader).toBeUndefined();
    expect(vi.mocked(db.saveSong).mock.calls.at(-1)?.[0].source.sheetReader).toBe('quick');
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
    // a computer (one crash may just have been a reload): the pick is not changed
    expect(useImport.getState().prefs.sheetReader).toBeUndefined();
    // a quick read that took the tab down: once more in the low-memory mode, still with the quick reader
    await useImport.getState().resumePending({ ...rec, source: { ...rec.source, sheetReader: 'quick' } });
    expect(accurateRead).not.toHaveBeenCalled();
    expect(quickRead.mock.calls[1][1]).toMatchObject({ threads: 1, release: true });
  });

  const crashed = (over: { lowMemory?: boolean } = {}) => ({
    id: 'p2',
    title: 'Prelude',
    kind: 'score' as const,
    source: { kind: 'score' as const, reader: 'pdf' as const, sheetReader: 'accurate' as const, fileName: 'prelude.pdf' },
    blob: new Blob(['%PDF']),
    mimeType: 'application/pdf',
    fileName: 'prelude.pdf',
    separate: false,
    startedAt: 1,
    sheet: { kind: 'pdf' as const, pages: [1], ...over },
  });

  it('"Try the Accurate reader again": the accurate reader once more, in its low-memory mode', async () => {
    await useImport.getState().resumePending(crashed(), { reader: 'accurate' });
    expect(quickRead).not.toHaveBeenCalled();
    expect(accurateRead).toHaveBeenCalledTimes(1);
    expect(accurateRead.mock.calls[0][1]).toMatchObject({ threads: 1, release: true });
    // the crash-recovery record says so (a second crash then offers only the quick reader)
    expect(vi.mocked(db.savePending).mock.calls.at(-1)?.[0]).toMatchObject({ id: 'p2', source: { sheetReader: 'accurate' }, sheet: { lowMemory: true } });
    expect(vi.mocked(db.saveSong).mock.calls.at(-1)?.[0].source.sheetReader).toBe('accurate');
    expect(useImport.getState().prefs.sheetReader).toBeUndefined();
  });

  it('the quick reader becomes the pick only where memory is the likely reason', async () => {
    // a second crash, already in the low-memory mode
    await useImport.getState().resumePending(crashed({ lowMemory: true }));
    expect(quickRead).toHaveBeenCalledTimes(1);
    expect(useImport.getState().prefs.sheetReader).toBe('quick');
    // a phone
    useImport.setState({ prefs: { separate: {}, sheetReader: 'accurate' } });
    vi.stubGlobal('navigator', { userAgent: iphone.ua, maxTouchPoints: 5 });
    try {
      await useImport.getState().resumePending(crashed());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(quickRead).toHaveBeenCalledTimes(2);
    expect(useImport.getState().prefs.sheetReader).toBe('quick');
  });

  it('photos for the accurate reader: the gray image when the color photo cannot be decoded the same way', async () => {
    const photo = { kind: 'photo' as const, photos: [{ blob: new Blob(['x'], { type: 'image/jpeg' }), name: 'p.jpg', quad: null }], fileName: 'p.jpg' };
    await useImport.getState().importSheet(photo);
    expect(accurateRead).toHaveBeenCalledTimes(1);
    // (no createImageBitmap here: the gray page is read)
    expect((accurateRead.mock.calls[0][0] as { image: unknown }[])[0].image).toBe(page);
  });
});

describe('the photo size for the accurate reader', () => {
  it('the gray size for photos up to 3000 px, the photo itself up to 4000 px for larger ones, never scaled up', () => {
    expect(photoDecodeSize({ w: 2000, h: 1500 }, { w: 2000, h: 1500 })).toBeNull();
    expect(photoDecodeSize({ w: 3000, h: 2250 }, { w: 8000, h: 6000 })).toEqual({ w: 4000, h: 3000 });
    // slightly over 3000 px: its own size, not 4000
    expect(photoDecodeSize({ w: 3000, h: 2250 }, { w: 3200, h: 2400 })).toEqual({ w: 3200, h: 2400 });
    expect(photoDecodeSize({ w: 2250, h: 3000 }, { w: 2400, h: 3200 })).toEqual({ w: 2400, h: 3200 });
    // size unknown: up to 4000
    expect(photoDecodeSize({ w: 3000, h: 2000 }, null)).toEqual({ w: 4000, h: 2667 });
  });
});

describe('the interrupted-import notice', () => {
  const base = { title: 'Prelude', kind: 'score' as const, blob: new Blob(['x']), sheet: { kind: 'pdf' as const, pages: [1] } };

  it('after the accurate reader on a computer: offers the quick reader and the accurate one again', () => {
    const n = interruptedNotice({ ...base, source: { sheetReader: 'accurate' } }, undefined, desktop);
    expect(n.canRetry).toBe(true);
    expect(n.retryLabel).toBe('Use the Quick reader');
    expect(n.retryAccurateLabel).toBe('Try the Accurate reader again');
    expect(n.body).toMatch(/with the Accurate reader was interrupted/);
    expect(n.body).toMatch(/Quick reader, which needs much less memory/);
    expect(n.body).toMatch(/try the Accurate reader again in a slower mode/);
    expect(n.body).not.toMatch(/picked for next time/);
  });

  it('after the accurate reader on a phone, or a second time: only the quick reader, and says it stays picked', () => {
    for (const [rec, device] of [
      [{ ...base, source: { sheetReader: 'accurate' } }, iphone],
      [{ ...base, sheet: { ...base.sheet, lowMemory: true }, source: { sheetReader: 'accurate' } }, desktop],
    ] as const) {
      const n = interruptedNotice(rec, undefined, device);
      expect(n.canRetry).toBe(true);
      expect(n.retryLabel).toBe('Use the Quick reader');
      expect(n.retryAccurateLabel).toBeUndefined();
      expect(n.body).toMatch(/Quick reader needs much less memory/);
      expect(n.body).toMatch(/The Quick reader is then picked for next time \(you can switch back on the Sheet music tab\)/);
    }
    const again = interruptedNotice({ ...base, sheet: { ...base.sheet, lowMemory: true }, source: { sheetReader: 'accurate' } }, undefined, desktop);
    expect(again.title).toBe('Reading the sheet music stopped again');
    expect(again.body).toMatch(/stopped again, even in the slower mode/);
    // the file was not kept: still names the quick reader
    const lost = interruptedNotice({ ...base, blob: undefined, sheet: undefined, source: { sheetReader: 'accurate' } }, undefined, desktop);
    expect(lost.retryAccurateLabel).toBeUndefined();
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
