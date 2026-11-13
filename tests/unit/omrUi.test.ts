/**
 * Sheet-music reader (beta) in the app: the crash-recovery record of a PDF / photo read (kept in the
 * IndexedDB 'pending' store next to older audio records), its notice, the timeline labels and the
 * source labels of read songs (older songs keep theirs).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { interruptedNotice } from '../../src/state/interruptedImport';
import { SHEET_PLAN, STAGE_LABELS, readScoreWarnings, sheetTitle, stageLabel } from '../../src/state/importStore';
import { sourceLabel } from '../../src/components/SongCard';
import { readFromSheet } from '../../src/components/studio/SheetReaderNotice';
import type { PendingImport } from '../../src/lib/storage/db';
import { capPhotos, maxPagesFor, MAX_PHONE_PAGES, MAX_READ_PAGES } from '../../src/components/import/SheetMusicTab';

describe('sheet-music reader: interrupted-import notice', () => {
  const pdf: Pick<PendingImport, 'title' | 'kind' | 'blob' | 'sheet'> = { title: 'Minuet', kind: 'score', blob: new Blob(['%PDF']), sheet: { kind: 'pdf', pages: [1, 2, 3] } };
  it('a PDF: kept, Try again in the low-memory mode', () => {
    const n = interruptedNotice(pdf);
    expect(n.canRetry).toBe(true);
    expect(n.canSave).toBe(false);
    expect(n.body).toMatch(/^Reading “Minuet” was interrupted — your browser probably ran out of memory\. Your file was kept\./);
    expect(n.body).toMatch(/slower mode that uses less memory/);
  });
  it('a crash during the low-memory retry is not offered again (no crash loop)', () => {
    const n = interruptedNotice({ ...pdf, sheet: { kind: 'pdf', pages: [1, 2, 3], lowMemory: true } });
    expect(n.canRetry).toBe(false);
    expect(n.title).toMatch(/stopped again/);
    expect(n.body).toMatch(/one page at a time/);
  });
  it('one photo: "Your photo was kept", no page advice', () => {
    const blob = new Blob(['jpg']);
    const n = interruptedNotice({ title: 'Photo', kind: 'score', blob, sheet: { kind: 'photo', photos: [{ blob, name: 'a.jpg', quad: [[0, 0], [9, 0], [9, 9], [0, 9]] }] } });
    expect(n.body).toMatch(/Your photo was kept\./);
    expect(n.body).not.toMatch(/fewer pages/);
    expect(n.canRetry).toBe(true);
  });
  it('without a kept copy (too large): choose the file again', () => {
    const n = interruptedNotice({ title: 'Big', kind: 'score', blob: undefined });
    expect(n.canRetry).toBe(false);
    expect(n.body).toMatch(/Choose the file again/);
    expect(interruptedNotice({ title: 'Big', kind: 'score', blob: undefined, sheet: { kind: 'pdf', pages: [1, 2] } }).body).toMatch(/read fewer pages at a time/);
  });
  it('audio records are unchanged', () => {
    expect(interruptedNotice({ title: 'song', kind: 'audio', blob: new Blob(['x']) }).body).toMatch(/^Your last import \(“song”\) was interrupted.*Your file was kept\.$/);
  });

  it('the record (PDF or photos with corners) round-trips through the pending store', async () => {
    const db = await import('../../src/lib/storage/db');
    const blob = new Blob(['jpg'], { type: 'image/jpeg' });
    const rec: PendingImport = {
      id: 'omr1',
      title: 'Photo',
      kind: 'score',
      source: { kind: 'score', reader: 'photo', fileName: 'a.jpg', pages: 2 },
      blob,
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
      startedAt: 1,
      presetId: 'piano',
      separate: false,
      sheet: { kind: 'photo', photos: [{ blob, name: 'a.jpg', quad: [[1, 2], [3, 4], [5, 6], [7, 8]] }, { blob, name: 'b.jpg', quad: null }] },
    };
    await db.savePending(rec);
    const back = await db.getPending('omr1');
    expect(back?.sheet?.kind).toBe('photo');
    expect(back?.sheet?.kind === 'photo' && back.sheet.photos.map((p) => p.quad)).toEqual([[[1, 2], [3, 4], [5, 6], [7, 8]], null]);
    expect(back?.source.reader).toBe('photo');
    await db.deletePending('omr1');
    await db.closeDb();
  });
});

describe('sheet-music reader: titles and warnings', () => {
  it('titles from file names: hyphens become spaces, first letter capital', () => {
    expect(sheetTitle('demo-prelude.pdf')).toBe('Demo prelude');
    expect(sheetTitle('Op. 28 - No. 4.pdf')).toBe('Op. 28 - No. 4');
    expect(sheetTitle('minuet_in_g.pdf')).toBe('Minuet in g');
  });
  it('the score import\'s "notes are not affected" is not said for read music', () => {
    const w = readScoreWarnings([
      'From bar 7, the bar lines in the piano roll and in the sheet music view no longer match the original score (it changes time signature or has a shorter bar there). The notes are not affected.',
      'This score changes key. The sheet music view uses the first key signature throughout; the notes are not affected.',
      'Something else.',
    ]);
    expect(w[0]).toMatch(/^From bar 7, .* no longer match your page/);
    expect(w[0]).toMatch(/Notes after it may come later than printed\.$/);
    expect(w.join(' ')).not.toMatch(/not affected/);
    expect(w[1]).toBe('This score changes key. The sheet music view uses the first key signature throughout.');
    expect(w[2]).toBe('Something else.');
  });
});

describe('sheet-music reader: page limits', () => {
  it('phones read a few pages at a time', () => {
    expect(maxPagesFor({ phone: true })).toBe(MAX_PHONE_PAGES);
    expect(maxPagesFor({ phone: false })).toBe(MAX_READ_PAGES);
    expect(MAX_PHONE_PAGES).toBeLessThanOrEqual(3);
  });
  it('choosing more photos than fit keeps the first ones and says so', () => {
    const files = Array.from({ length: 15 }, (_, i) => i);
    expect(capPhotos(files, 10, 10)).toEqual({ keep: files.slice(0, 10), note: 'Only the first 10 photos were added: up to 10 pages can be read at a time.' });
    expect(capPhotos(files.slice(0, 2), 3, 3)).toEqual({ keep: [0, 1], note: null });
    expect(capPhotos(files, 0, 3).keep).toEqual([]);
    expect(capPhotos(files, 0, 3).note).toMatch(/Up to 3 pages/);
  });
});

describe('sheet-music reader: labels', () => {
  it('timeline: own labels for the reader, the usual ones otherwise', () => {
    expect(SHEET_PLAN.map((s) => stageLabel({ sheet: 'pdf' }, s))).toEqual(['Preparing the pages', 'Loading the sheet-music reader', 'Reading the music', 'Building arrangements', 'Saving']);
    expect(stageLabel({}, 'analyzing')).toBe(STAGE_LABELS.analyzing);
  });
  it('library: read songs say what they were read from; files and older songs keep "Sheet music"', () => {
    expect(sourceLabel('score', 'pdf')).toBe('Read from a PDF');
    expect(sourceLabel('score', 'photo')).toBe('Read from a photo');
    expect(sourceLabel('score')).toBe('Sheet music');
    expect(sourceLabel('midi')).toBe('MIDI file');
    expect(readFromSheet({ source: { kind: 'score', reader: 'pdf' } })).toBe(true);
    expect(readFromSheet({ source: { kind: 'score', fileName: 'a.musicxml' } })).toBe(false);
    expect(readFromSheet({ source: { kind: 'audio' } })).toBe(false);
  });
});
