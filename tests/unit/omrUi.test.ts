/**
 * Sheet-music reader (beta) in the app: the crash-recovery record of a PDF / photo read (kept in the
 * IndexedDB 'pending' store next to older audio records), its notice, the timeline labels and the
 * source labels of read songs (older songs keep theirs).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { interruptedNotice } from '../../src/state/interruptedImport';
import { SHEET_PLAN, STAGE_LABELS, stageLabel } from '../../src/state/importStore';
import { sourceLabel } from '../../src/components/SongCard';
import { readFromSheet } from '../../src/components/studio/SheetReaderNotice';
import type { PendingImport } from '../../src/lib/storage/db';

describe('sheet-music reader: interrupted-import notice', () => {
  const pdf: Pick<PendingImport, 'title' | 'kind' | 'blob' | 'sheet'> = { title: 'Minuet', kind: 'score', blob: new Blob(['%PDF']), sheet: { kind: 'pdf', pages: [1, 2, 3] } };
  it('a PDF: kept, Try again, advice to read fewer pages', () => {
    const n = interruptedNotice(pdf);
    expect(n.canRetry).toBe(true);
    expect(n.canSave).toBe(false);
    expect(n.body).toMatch(/^Reading “Minuet” was interrupted — your browser probably ran out of memory\. Your file was kept\./);
    expect(n.body).toMatch(/read fewer pages at a time/);
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
