/**
 * Cancelling a video export (src/lib/export): the dialog's runs, waiting on steps that can't be
 * stopped part-way, and the export file in the browser's private storage.
 */
import { describe, expect, it } from 'vitest';
import { settleWithin, untilAborted } from '../../src/lib/export/guard';
import { ExportRunner } from '../../src/lib/export/exportRunner';
import { STALE_EXPORT_MS, cleanupExportFiles, exportFileTime, openExportFile } from '../../src/lib/export/exportFiles';
import { DOWNLOAD_URL_LIFETIME_MS } from '../../src/lib/export/downloads';

const never = <T = void>() => new Promise<T>(() => {});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('untilAborted', () => {
  it('gives the step’s value or error when nothing is cancelled', async () => {
    const ac = new AbortController();
    await expect(untilAborted(Promise.resolve(4), ac.signal)).resolves.toBe(4);
    await expect(untilAborted(Promise.reject(new Error('bad')), ac.signal)).rejects.toThrow('bad');
    await expect(untilAborted(Promise.resolve(5), undefined)).resolves.toBe(5);
  });

  it('answers a cancel at once, while the step is still going', async () => {
    const ac = new AbortController();
    const p = untilAborted(never(), ac.signal);
    setTimeout(() => ac.abort(), 5);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('hands what the step gives back after the cancel to `late` (to release it), and ignores its error', async () => {
    const ac = new AbortController();
    let finish!: (v: { closed: boolean }) => void;
    const step = new Promise<{ closed: boolean }>((r) => (finish = r));
    const released: { closed: boolean }[] = [];
    const p = untilAborted(step, ac.signal, (v) => released.push(v));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const value = { closed: false };
    finish(value);
    await tick();
    expect(released).toEqual([value]);

    // already cancelled: the step's failure is not an unhandled rejection
    const failing = Promise.reject(new Error('late failure'));
    await expect(untilAborted(failing, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a value that arrived first is returned, not released', async () => {
    const ac = new AbortController();
    const released: number[] = [];
    const v = await untilAborted(Promise.resolve(1), ac.signal, (x) => released.push(x));
    ac.abort();
    await tick();
    expect(v).toBe(1);
    expect(released).toEqual([]);
  });
});

describe('settleWithin', () => {
  it('tells whether a step ended in time, and never throws', async () => {
    await expect(settleWithin(Promise.resolve(), 50)).resolves.toBe(true);
    await expect(settleWithin(Promise.reject(new Error('x')), 50)).resolves.toBe(true);
    await expect(settleWithin(never(), 20)).resolves.toBe(false);
  });
});

describe('ExportRunner (the export dialog’s runs)', () => {
  it('runs one export at a time; only the current run may update the dialog', async () => {
    const r = new ExportRunner(100);
    let finish!: () => void;
    let current!: () => boolean;
    const done = r.start(async (_signal, cur) => {
      current = cur;
      await new Promise<void>((res) => (finish = res));
    });
    expect(done).not.toBeNull();
    expect(r.running).toBe(true);
    expect(current()).toBe(true);
    expect(r.start(async () => {})).toBeNull(); // Render is off while one runs
    finish();
    await done;
    expect(r.running).toBe(false);
    expect(current()).toBe(false);
  });

  it('a cancel that ends quickly gives Render back as soon as the run has stopped', async () => {
    const r = new ExportRunner(5000);
    let signal!: AbortSignal;
    r.start(async (s) => {
      signal = s;
      await new Promise<void>((_, rej) => s.addEventListener('abort', () => setTimeout(() => rej(new DOMException('x', 'AbortError')), 20)));
    });
    const t0 = Date.now();
    const stopped = r.stop();
    expect(signal.aborted).toBe(true);
    expect(r.running).toBe(false);
    expect(r.stopping).toBe(true);
    expect(r.start(async () => {})).toBeNull(); // still letting go of the encoders
    await stopped;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.stopping).toBe(false);
    expect(r.start(async () => {})).not.toBeNull();
  });

  it('a run that can’t be stopped never keeps Render off for longer than the limit', async () => {
    const r = new ExportRunner(40);
    let oldCurrent!: () => boolean;
    let finishOld!: () => void;
    r.start(async (_s, cur) => {
      oldCurrent = cur;
      await new Promise<void>((res) => (finishOld = res)); // ignores the cancel (a decode that can't be stopped)
    });
    const t0 = Date.now();
    await r.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.stopping).toBe(false);

    // a new export starts while the old one still runs in the background
    let newCurrent!: () => boolean;
    let finishNew!: () => void;
    const second = r.start(async (_s, cur) => {
      newCurrent = cur;
      await new Promise<void>((res) => (finishNew = res));
    });
    expect(second).not.toBeNull();
    // the old one ends late: it can't touch the dialog, and the new run is still the running one
    finishOld();
    await tick();
    expect(oldCurrent()).toBe(false);
    expect(newCurrent()).toBe(true);
    expect(r.running).toBe(true);
    expect(r.start(async () => {})).toBeNull();
    finishNew();
    await second;
    expect(r.running).toBe(false);
  });

  it('stop without a run does nothing; a task that throws does not leave the runner stuck', async () => {
    const r = new ExportRunner(50);
    await r.stop();
    expect(r.stopping).toBe(false);
    await r.start(async () => {
      throw new Error('export failed');
    });
    expect(r.running).toBe(false);
    expect(r.start(async () => {})).not.toBeNull();
  });
});

// ---------- a fake Origin Private File System ----------
interface FakeFile {
  writes: unknown[];
  open: boolean;
  closed: boolean;
  aborted: boolean;
}
function fakeRoot() {
  const files = new Map<string, FakeFile>();
  const removed: string[] = [];
  const root = {
    files,
    removed,
    async getFileHandle(name: string) {
      const f: FakeFile = files.get(name) ?? { writes: [], open: false, closed: false, aborted: false };
      files.set(name, f);
      return {
        async createWritable() {
          f.open = true;
          return new WritableStream({
            write: async (chunk) => {
              await tick(1);
              f.writes.push(chunk);
            },
            close: () => {
              f.open = false;
              f.closed = true;
            },
            abort: () => {
              f.open = false;
              f.aborted = true;
            },
          });
        },
        async getFile() {
          return { size: f.writes.length } as unknown as File;
        },
      };
    },
    async removeEntry(name: string) {
      const f = files.get(name);
      if (!f) throw new DOMException('not found', 'NotFoundError');
      if (f.open) throw new DOMException('the file is open', 'NoModificationAllowedError'); // as in Chromium
      files.delete(name);
      removed.push(name);
    },
    async *keys() {
      for (const k of [...files.keys()]) yield k;
    },
  };
  return root;
}
function fakeLocks() {
  const held = new Set<string>();
  return {
    held,
    request(name: string, a: unknown, b?: unknown) {
      const opts = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
      const cb = (typeof a === 'function' ? a : b) as (lock: unknown) => Promise<unknown>;
      if (held.has(name)) {
        if (opts.ifAvailable) return Promise.resolve(cb(null));
        return never();
      }
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    },
  };
}
const asRoot = (r: ReturnType<typeof fakeRoot>) => r as unknown as FileSystemDirectoryHandle;
const asLocks = (l: ReturnType<typeof fakeLocks>) => l as unknown as Pick<LockManager, 'request'>;

describe('export file in the browser’s private storage', () => {
  it('passes the muxer’s writes through unchanged and gives the finished file', async () => {
    const root = fakeRoot();
    const f = (await openExportFile('mp4', { root: asRoot(root), locks: null, now: 1000 }))!;
    const w = f.writable.getWriter();
    const chunk = { type: 'write', position: 0, data: new Uint8Array([1, 2, 3]) };
    await w.write(chunk);
    await w.close();
    const file = root.files.get('export-1000.mp4')!;
    expect(file.writes).toEqual([chunk]);
    expect(file.closed).toBe(true);
    expect((await f.getFile()).size).toBe(1);
  });

  it('a cancel closes the file itself (writes still queued) and removes it', async () => {
    const root = fakeRoot();
    const locks = fakeLocks();
    const f = (await openExportFile('mp4', { root: asRoot(root), locks: asLocks(locks), now: 2000 }))!;
    expect(locks.held.size).toBe(1); // in use
    const w = f.writable.getWriter();
    // the muxer has writes in flight and never closes (an encoder flush it waits on never ends)
    void w.write({ type: 'write', position: 0, data: new Uint8Array(4) }).catch(() => {});
    void w.write({ type: 'write', position: 4, data: new Uint8Array(4) }).catch(() => {});
    await f.discard();
    expect(root.files.has('export-2000.mp4')).toBe(false);
    expect(root.removed).toEqual(['export-2000.mp4']);
    await tick();
    expect(locks.held.size).toBe(0); // let go of
    await f.discard(); // again: nothing more happens
    expect(root.removed).toEqual(['export-2000.mp4']);
    await expect(w.write({ type: 'write', position: 8, data: new Uint8Array(1) })).rejects.toBeTruthy();
  });

  it('a finished video’s file can be removed when the video is let go of', async () => {
    const root = fakeRoot();
    const f = (await openExportFile('webm', { root: asRoot(root), locks: null, now: 3000 }))!;
    const w = f.writable.getWriter();
    await w.write({ type: 'write', position: 0, data: new Uint8Array(2) });
    await w.close();
    await f.discard();
    expect(root.removed).toEqual(['export-3000.webm']);
  });

  it('without storage it falls back to memory (null)', async () => {
    const broken = { getFileHandle: async () => ({ createWritable: async () => Promise.reject(new Error('not allowed')) }), removeEntry: async () => {} };
    expect(await openExportFile('mp4', { root: broken as unknown as FileSystemDirectoryHandle, locks: null })).toBeNull();
  });

  it('cleanup removes files no tab uses (startup), and leaves the ones in use', async () => {
    const root = fakeRoot();
    const locks = fakeLocks();
    for (const n of ['export-1.mp4', 'export-1.mp4.crswap', 'export-2.webm', 'song.bin']) root.files.set(n, { writes: [], open: false, closed: true, aborted: false });
    const inUse = (await openExportFile('mp4', { root: asRoot(root), locks: asLocks(locks), now: 5 }))!;
    const removed = await cleanupExportFiles({ root: asRoot(root), locks: asLocks(locks) });
    expect(removed).toBe(3);
    expect([...root.files.keys()].sort()).toEqual(['export-5.mp4', 'song.bin']);
    await inUse.discard();
    expect([...root.files.keys()]).toEqual(['song.bin']);
  });

  it('without Web Locks only files older than a day are taken as left over', async () => {
    const root = fakeRoot();
    const now = 10 * STALE_EXPORT_MS;
    root.files.set(`export-${now - STALE_EXPORT_MS - 1}.mp4`, { writes: [], open: false, closed: true, aborted: false });
    root.files.set(`export-${now - 1000}.mp4`, { writes: [], open: false, closed: true, aborted: false });
    expect(await cleanupExportFiles({ root: asRoot(root), locks: null, now })).toBe(1);
    expect([...root.files.keys()]).toEqual([`export-${now - 1000}.mp4`]);
    expect(exportFileTime('export-123.mp4.crswap')).toBe(123);
    expect(exportFileTime('other')).toBeNaN();
  });
});

describe('downloads', () => {
  it('the download link outlives Safari’s “Do you want to download?” question', () => {
    expect(DOWNLOAD_URL_LIFETIME_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
