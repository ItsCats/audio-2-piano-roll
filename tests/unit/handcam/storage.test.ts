/** The hands video store: the upgrade from version 2 keeps every store and its data; videos go with their song. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import type { Song } from '../../../src/lib/music/types';

describe('hands video storage (IndexedDB version 3)', () => {
  it('upgrades a version-2 library keeping its data; a hands video is stored, read and deleted with the song', async () => {
    const v2 = await openDB('pianovision', 2, {
      upgrade(d) {
        d.createObjectStore('songs', { keyPath: 'id' });
        const s = d.createObjectStore('summaries', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        d.createObjectStore('audio');
        d.createObjectStore('posteriors');
        d.createObjectStore('media', { keyPath: 'id' });
        d.createObjectStore('pending', { keyPath: 'id' });
      },
    });
    await v2.put('songs', { id: 's1', title: 'Old song', base: [], arrangements: {} });
    await v2.put('audio', { blob: new Blob(['video-as-original'], { type: 'video/mp4' }), name: 'me.mp4', type: 'video/mp4' }, 's1');
    await v2.put('pending', { id: 'p1', startedAt: 1 });
    v2.close();

    const db = await import('../../../src/lib/storage/db');
    expect(db.DB_VERSION).toBe(3);
    expect((await db.getSong('s1'))?.title).toBe('Old song');
    expect((await db.listPending()).map((p) => p.id)).toEqual(['p1']);

    const base = { v: 1, fileName: 'me.mp4', mimeType: 'video/mp4', size: 1, duration: 1, displayW: 640, displayH: 360, rotation: 0, offset: 0, addedAt: 1 } as const;
    // imported from the video: the original recording is the video (no second copy)
    const a = { id: 's1', handVideo: { ...base, store: 'audio' as const } };
    expect(await (await db.getHandVideoBlob(a))?.text()).toBe('video-as-original');
    // added later: its own store
    const b = { id: 's2', handVideo: { ...base, store: 'handcam' as const } };
    expect(await db.getHandVideoBlob(b)).toBeUndefined();
    await db.saveHandVideoBlob('s2', new Blob(['hands'], { type: 'video/mp4' }), 'hands.mp4');
    expect(await (await db.getHandVideoBlob(b))?.text()).toBe('hands');
    expect(await db.getHandVideoBlob({ id: 's2' })).toBeUndefined();
    await db.saveSong({ id: 's2', title: 'New', base: [], arrangements: {}, tempo: { bpm: 1 }, transcription: { estimated: false }, source: { kind: 'midi' }, ...b } as unknown as Song);
    await db.deleteSong('s2');
    expect(await db.getHandVideoBlob(b)).toBeUndefined();
    await db.saveHandVideoBlob('s3', new Blob(['x']), 'x.mp4');
    await db.deleteHandVideoBlob('s3');
    expect(await db.getHandVideoBlob({ id: 's3', handVideo: { ...base, store: 'handcam' } })).toBeUndefined();
    await db.closeDb();
  });
});
