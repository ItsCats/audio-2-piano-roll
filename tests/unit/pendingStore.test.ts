/**
 * The interrupted-import store against a real IndexedDB (fake-indexeddb): the upgrade while a tab of
 * the previous version still has the database open, saving a song and deleting its record in one
 * transaction, and a cleanup that must not delete a newer run's record.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import type { PendingImport } from '../../src/lib/storage/db';
import type { Song } from '../../src/lib/music/types';

const rec = (id: string, startedAt: number): PendingImport => ({
  id,
  title: 'Recording 1',
  kind: 'capture',
  source: { kind: 'capture', mimeType: 'audio/mp4' },
  blob: new Blob(['recorded'], { type: 'audio/mp4' }),
  mimeType: 'audio/mp4',
  fileName: 'Recording 1.m4a',
  startedAt,
  presetId: 'piano',
  separate: false,
});

const song = (id: string) =>
  ({
    id,
    title: 'New song',
    createdAt: 1,
    updatedAt: 2,
    duration: 10,
    source: { kind: 'capture' },
    base: [],
    arrangements: {},
    tempo: { bpm: 120 },
    transcription: { estimated: true },
  }) as unknown as Song;

describe('pending store against a real IndexedDB', () => {
  it('a tab still on version 1 blocks the upgrade: the app is told, and carries on once that tab closes', async () => {
    const old = await openDB('pianovision', 1, {
      upgrade(d) {
        d.createObjectStore('songs', { keyPath: 'id' });
        const s = d.createObjectStore('summaries', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        d.createObjectStore('audio');
        d.createObjectStore('posteriors');
        d.createObjectStore('media', { keyPath: 'id' });
      },
    });
    await old.put('summaries', { id: 's1', title: 'Old song', updatedAt: 5, createdAt: 1 });
    // the previous version of the app has no versionchange handler: the connection stays open
    const db = await import('../../src/lib/storage/db');
    const states: boolean[] = [];
    const off = db.watchDatabaseBlocked((b) => states.push(b));
    const list = db.listSummaries();
    await expect.poll(() => states).toEqual([true]);
    // a listener added while blocked hears it at once
    const late: boolean[] = [];
    db.watchDatabaseBlocked((b) => late.push(b))();
    expect(late).toEqual([true]);
    old.close();
    expect((await list).map((s) => s.id)).toEqual(['s1']);
    await expect.poll(() => states).toEqual([true, false]);
    off();
  });

  it('saving the song deletes its record in the same transaction (both or neither)', async () => {
    const db = await import('../../src/lib/storage/db');
    await db.savePending(rec('p1', 100));
    await db.saveSong(song('song-1'), { pendingId: 'p1' });
    expect(await db.getPending('p1')).toBeUndefined();
    expect((await db.getSong('song-1'))?.title).toBe('New song');

    // a save that fails leaves the record (the recording is not lost)
    await db.savePending(rec('p2', 200));
    const broken = { ...song('x'), id: undefined } as unknown as Song; // no key: the put throws
    await expect(db.saveSong(broken, { pendingId: 'p2' })).rejects.toThrow();
    expect((await db.getPending('p2'))?.id).toBe('p2');
    // other saves don't touch the records
    await db.saveSong(song('song-2'));
    expect((await db.getPending('p2'))?.id).toBe('p2');
  });

  it('a cleanup only deletes the run it wrote (a resumed import rewrote the record under the same id)', async () => {
    const db = await import('../../src/lib/storage/db');
    await db.savePending(rec('p3', 300));
    await db.savePending(rec('p3', 400)); // resumed
    await db.deletePending('p3', 300); // the earlier run's cleanup
    expect((await db.getPending('p3'))?.startedAt).toBe(400);
    await db.deletePending('p3', 400);
    expect(await db.getPending('p3')).toBeUndefined();
    // without startedAt: unconditional (Discard)
    await db.savePending(rec('p4', 500));
    await db.deletePending('p4');
    expect(await db.getPending('p4')).toBeUndefined();
  });

  it('"Try again" checks the record is still there and not running in another tab', async () => {
    const db = await import('../../src/lib/storage/db');
    const { stillInterrupted } = await import('../../src/state/interruptedImport');
    await db.savePending(rec('p5', 600));
    expect(await stillInterrupted('p5')).toBe(true);
    const nav = globalThis.navigator as unknown as { locks?: unknown };
    const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { ...nav, locks: { query: async () => ({ held: [{ name: 'piano2vision-import:p5' }], pending: [] }) } },
    });
    try {
      expect(await stillInterrupted('p5')).toBe(false); // another tab resumed it
    } finally {
      if (had) Object.defineProperty(globalThis, 'navigator', had);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
    await db.deletePending('p5'); // discarded in another tab
    expect(await stillInterrupted('p5')).toBe(false);
    await db.closeDb();
  });
});
