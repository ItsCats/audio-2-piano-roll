/**
 * iPhone "page reloads mid-analysis" fix: the transcription backend choice, the interrupted-import
 * store (IndexedDB upgrade from version 1 with existing data), the next-load notice, the screen wake
 * lock and the light piano for phones.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { WEBGL_MEMORY_FLAGS, batchFor, chooseBackendOrder, isAppleMobile, isMemoryConstrained } from '../../src/lib/transcription/backendChoice';
import { createScreenWakeLock, type WakeLockSentinelLike } from '../../src/lib/wakeLock';
import { lightLayers, wantsLightPiano } from '../../src/lib/audio/sampleLibrary';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const gpu = { softwareRenderer: false, offscreen: true };

describe('chooseBackendOrder', () => {
  it('iPhone (iOS 17+: WebGL in workers, "Apple GPU") runs WASM first', () => {
    const order = chooseBackendOrder({ ua: UA.iphone, maxTouchPoints: 5, ...gpu });
    expect(order[0]).toBe('wasm');
    expect(order.indexOf('webgl')).toBeGreaterThan(order.indexOf('wasm'));
    expect(order.at(-1)).toBe('cpu');
  });

  it('an iPad in desktop mode (a Mac UA with a touch screen) is treated as iOS; a real Mac is not', () => {
    expect(isAppleMobile(UA.ipadDesktop, 5)).toBe(true);
    expect(isAppleMobile(UA.ipadDesktop, 0)).toBe(false);
    expect(chooseBackendOrder({ ua: UA.ipadDesktop, maxTouchPoints: 5, ...gpu })[0]).toBe('wasm');
    expect(chooseBackendOrder({ ua: UA.mac, maxTouchPoints: 0, deviceMemory: 8, ...gpu })[0]).toBe('webgl');
  });

  it('Android phones, mobile UA hints and devices with 4 GB or less run WASM first', () => {
    expect(chooseBackendOrder({ ua: UA.android, maxTouchPoints: 5, deviceMemory: 8, ...gpu })[0]).toBe('wasm');
    expect(chooseBackendOrder({ ua: UA.windows, mobile: true, ...gpu })[0]).toBe('wasm');
    expect(chooseBackendOrder({ ua: UA.windows, deviceMemory: 4, ...gpu })[0]).toBe('wasm');
    expect(chooseBackendOrder({ ua: UA.windows, deviceMemory: 2, ...gpu })[0]).toBe('wasm');
    expect(isMemoryConstrained({ ua: UA.windows, deviceMemory: 8 })).toBe(false);
    // Safari/Firefox report no deviceMemory: a desktop stays a desktop
    expect(isMemoryConstrained({ ua: UA.mac })).toBe(false);
  });

  it('desktops with a hardware GPU keep WebGL first; software GL and no OffscreenCanvas do not', () => {
    expect(chooseBackendOrder({ ua: UA.windows, deviceMemory: 8, ...gpu })).toEqual(['webgl', 'wasm', 'cpu']);
    expect(chooseBackendOrder({ ua: UA.windows, deviceMemory: 8, softwareRenderer: true, offscreen: true })).toEqual(['wasm', 'webgl', 'cpu']);
    expect(chooseBackendOrder({ ua: UA.windows, deviceMemory: 8, softwareRenderer: false, offscreen: false })).toEqual(['wasm', 'cpu']);
  });

  it('a preferred backend (test hook) goes first, without duplicates', () => {
    expect(chooseBackendOrder({ ua: UA.iphone, maxTouchPoints: 5, ...gpu }, 'webgl')).toEqual(['webgl', 'wasm', 'cpu']);
  });

  it('WebGL always runs with the memory-safe flags and small batches', () => {
    expect(WEBGL_MEMORY_FLAGS).toEqual({ WEBGL_CONV_IM2COL: false, WEBGL_DELETE_TEXTURE_THRESHOLD: 0 });
    expect(batchFor('webgl')).toBe(1);
    expect(batchFor('wasm')).toBe(2);
    expect(batchFor('cpu')).toBe(1);
  });
});

describe('interrupted-import store (IndexedDB)', () => {
  it('upgrades a version-1 library to version 2 keeping every store and its data, then round-trips a record', async () => {
    // a library written by the previous version of the app
    const v1 = await openDB('pianovision', 1, {
      upgrade(d) {
        d.createObjectStore('songs', { keyPath: 'id' });
        const s = d.createObjectStore('summaries', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        d.createObjectStore('audio');
        d.createObjectStore('posteriors');
        d.createObjectStore('media', { keyPath: 'id' });
      },
    });
    await v1.put('songs', { id: 's1', title: 'Old song', base: [], arrangements: {} });
    await v1.put('summaries', { id: 's1', title: 'Old song', updatedAt: 5, createdAt: 1 });
    await v1.put('audio', { blob: new Blob(['old-audio'], { type: 'audio/mpeg' }), name: 'old.mp3', type: 'audio/mpeg' }, 's1');
    await v1.put('posteriors', { nFrames: 1 }, 's1');
    await v1.put('media', { id: 'm1', name: 'bg.png', type: 'image/png', kind: 'image', blob: new Blob(['png']), createdAt: 2 });
    v1.close();

    const db = await import('../../src/lib/storage/db');
    expect(db.DB_NAME).toBe('pianovision');
    expect(db.DB_VERSION).toBe(3);
    // the old data is all still there
    expect((await db.getSong('s1'))?.title).toBe('Old song');
    expect((await db.listSummaries()).map((s) => s.id)).toEqual(['s1']);
    expect(await (await db.getAudio('s1'))?.text()).toBe('old-audio');
    expect(await db.getPosteriors('s1')).toEqual({ nFrames: 1 });
    expect((await db.listMedia()).map((m) => m.id)).toEqual(['m1']);

    // the new store works
    expect(await db.listPending()).toEqual([]);
    const blob = new Blob(['recorded'], { type: 'audio/mp4' });
    const rec = {
      id: 'p1',
      title: 'Recording 1',
      kind: 'capture' as const,
      source: { kind: 'capture' as const, mimeType: 'audio/mp4' },
      blob,
      mimeType: 'audio/mp4',
      fileName: 'Recording 1.m4a',
      startedAt: 100,
      presetId: 'piano',
      separate: false,
    };
    await db.savePending(rec);
    await db.savePending({ ...rec, id: 'p0', startedAt: 50 });
    const list = await db.listPending();
    expect(list.map((r) => r.id)).toEqual(['p1', 'p0']);
    expect(await list[0].blob!.text()).toBe('recorded');
    expect(list[0]).toMatchObject({ title: 'Recording 1', presetId: 'piano', separate: false, fileName: 'Recording 1.m4a' });
    await db.deletePending('p1');
    expect((await db.listPending()).map((r) => r.id)).toEqual(['p0']);

    // reopening at the current version does not touch anything
    await db.closeDb();
    const raw = await openDB('pianovision', 3);
    expect([...raw.objectStoreNames].sort()).toEqual(['audio', 'handcam', 'media', 'pending', 'posteriors', 'songs', 'summaries']);
    raw.close();
    expect((await db.listPending()).map((r) => r.id)).toEqual(['p0']);
    expect((await db.getSong('s1'))?.title).toBe('Old song');
    await db.closeDb();
  });
});

describe('interrupted-import notice', async () => {
  const { pickInterrupted, interruptedNotice } = await import('../../src/state/interruptedImport');
  const rec = (id: string, startedAt: number, extra: Record<string, unknown> = {}) =>
    ({ id, title: `T${id}`, kind: 'capture', source: { kind: 'capture' }, blob: new Blob(['x']), mimeType: 'audio/mp4', fileName: 'x.m4a', startedAt, presetId: 'piano', separate: false, ...extra }) as const;

  it('reports the newest record from before this page load that no open tab is still running', () => {
    expect(pickInterrupted([], 1000, new Set())).toBeNull();
    expect(pickInterrupted([rec('a', 500), rec('b', 900)], 1000, new Set())?.id).toBe('b');
    // written by this page load: not interrupted
    expect(pickInterrupted([rec('a', 500), rec('c', 1500)], 1000, new Set())?.id).toBe('a');
    // another tab is running it (holds its lock)
    expect(pickInterrupted([rec('a', 500), rec('b', 900)], 1000, new Set(['piano2vision-import:b']))?.id).toBe('a');
    expect(pickInterrupted([rec('b', 900)], 1000, new Set(['piano2vision-import:b']))).toBeNull();
  });

  it('says what happened in plain words and offers what is possible', () => {
    const n = interruptedNotice(rec('a', 1, { title: 'Recording 11/11/2026' }));
    expect(n.body).toBe('Your last import (“Recording 11/11/2026”) was interrupted — your browser probably ran out of memory. Your recording was kept.');
    expect(n.canRetry).toBe(true);
    expect(n.canSave).toBe(true);
    expect(n.body).not.toMatch(/WebGL|WASM|IndexedDB|jetsam|memory budget/i);
    const file = interruptedNotice({ title: 'song', kind: 'audio', blob: new Blob(['x']) });
    expect(file.body).toMatch(/Your file was kept\.$/);
    expect(file.canSave).toBe(false);
    const big = interruptedNotice({ title: 'film', kind: 'audio', blob: undefined });
    expect(big.canRetry).toBe(false);
    expect(big.body).toMatch(/Choose the file again/);
  });
});

describe('screen wake lock', () => {
  function fakeEnv(opts: { reject?: boolean } = {}) {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_t: string, l: () => void) => listeners.add(l),
      removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
    };
    const sentinels: (WakeLockSentinelLike & { released: boolean; fire: () => void })[] = [];
    const nav = {
      wakeLock: {
        request: vi.fn(async () => {
          if (opts.reject) throw new DOMException('denied', 'NotAllowedError');
          let onRelease: (() => void) | null = null;
          const s = {
            released: false,
            release: vi.fn(async () => {
              s.released = true;
              onRelease?.();
            }),
            addEventListener: (_t: 'release', l: () => void) => (onRelease = l),
            // the browser drops the lock when the page is hidden
            fire: () => {
              s.released = true;
              onRelease?.();
            },
          };
          sentinels.push(s);
          return s;
        }),
      },
    };
    const setVisible = (v: boolean) => {
      doc.visibilityState = v ? 'visible' : 'hidden';
      listeners.forEach((l) => l());
    };
    return { doc, nav, sentinels, setVisible, listeners };
  }

  it('holds the lock while busy, takes it again when the page is visible again, releases it at the end', async () => {
    const env = fakeEnv();
    const lock = createScreenWakeLock(env.nav, env.doc);
    expect(lock.supported).toBe(true);
    await lock.hold(true);
    expect(env.nav.wakeLock.request).toHaveBeenCalledWith('screen');
    expect(lock.active).toBe(true);
    await lock.hold(true); // no second request while held
    expect(env.nav.wakeLock.request).toHaveBeenCalledTimes(1);
    // screen locked / tab hidden: the browser releases it
    env.sentinels[0].fire();
    env.setVisible(false);
    expect(lock.active).toBe(false);
    env.setVisible(true);
    await vi.waitFor(() => expect(lock.active).toBe(true));
    expect(env.nav.wakeLock.request).toHaveBeenCalledTimes(2);
    await lock.hold(false);
    expect(env.sentinels[1].release).toHaveBeenCalled();
    expect(lock.active).toBe(false);
    expect(env.listeners.size).toBe(0);
    // not busy any more: becoming visible takes nothing
    env.setVisible(true);
    expect(env.nav.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it('a lock that arrives after the import ended is released at once', async () => {
    const env = fakeEnv();
    const lock = createScreenWakeLock(env.nav, env.doc);
    const p = lock.hold(true);
    await lock.hold(false);
    await p;
    await vi.waitFor(() => expect(env.sentinels[0]?.released).toBe(true));
    expect(lock.active).toBe(false);
  });

  it('never throws: no API, a refused request, a hidden page', async () => {
    const none = createScreenWakeLock({}, undefined);
    expect(none.supported).toBe(false);
    await expect(none.hold(true)).resolves.toBeUndefined();
    const env = fakeEnv({ reject: true });
    const refused = createScreenWakeLock(env.nav, env.doc);
    await expect(refused.hold(true)).resolves.toBeUndefined();
    expect(refused.active).toBe(false);
    await expect(refused.hold(false)).resolves.toBeUndefined();
    const hidden = fakeEnv();
    hidden.doc.visibilityState = 'hidden';
    const lock = createScreenWakeLock(hidden.nav, hidden.doc);
    await lock.hold(true);
    expect(hidden.nav.wakeLock.request).not.toHaveBeenCalled();
  });
});

describe('light piano on phones', () => {
  it('iOS, small memory and phone-sized touch screens get the light piano; desktops do not', () => {
    expect(wantsLightPiano({ ua: UA.iphone, maxTouchPoints: 5, screenMin: 390 })).toBe(true);
    expect(wantsLightPiano({ ua: UA.ipadDesktop, maxTouchPoints: 5, screenMin: 820 })).toBe(true);
    expect(wantsLightPiano({ ua: UA.android, maxTouchPoints: 5, deviceMemory: 8, screenMin: 412 })).toBe(true);
    expect(wantsLightPiano({ ua: UA.windows, deviceMemory: 4, screenMin: 1080 })).toBe(true);
    expect(wantsLightPiano({ ua: UA.windows, deviceMemory: 8, maxTouchPoints: 0, screenMin: 1080 })).toBe(false);
    expect(wantsLightPiano({ ua: UA.mac, maxTouchPoints: 0, screenMin: 900 })).toBe(false);
    // a touch laptop with a big screen keeps the full piano
    expect(wantsLightPiano({ ua: UA.windows, deviceMemory: 8, maxTouchPoints: 10, screenMin: 1080 })).toBe(false);
  });

  it('keeps the medium (first-loaded) layer and a firm one of the five', () => {
    const layers = [31, 49, 69, 93, 117].map((vel) => ({ vel, file: `v${vel}.mp3` }));
    expect(lightLayers(layers).map((l) => l.vel)).toEqual([69, 93]);
    expect(lightLayers(layers.slice(0, 1))).toHaveLength(1);
  });
});

describe('separation default on iOS (Safari has no deviceMemory)', () => {
  it('is not recommended on an iPhone or an iPad, so "Full song" does not tick it by default', async () => {
    vi.stubGlobal('Worker', class {});
    try {
      const { separationSupport } = await import('../../src/lib/separation');
      for (const [ua, mtp] of [
        [UA.iphone, 5],
        [UA.ipadDesktop, 5],
      ] as const) {
        vi.stubGlobal('navigator', { userAgent: ua, hardwareConcurrency: 6, maxTouchPoints: mtp });
        const s = separationSupport();
        expect(s.recommended).toBe(false);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
