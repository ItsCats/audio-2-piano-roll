/**
 * The export's file in the Origin Private File System (OPFS), so long videos don't have to fit in
 * memory. Kept free of mediabunny so the startup cleanup stays a tiny chunk.
 *
 * A file is in use from the moment an export opens it until its video is thrown away (a new video
 * replaces it, the dialog goes away); a Web Lock with the file's name is held for that time, so the
 * cleanup in another tab (or after a reload) never removes a video someone is still looking at.
 *
 * The export writes through our own stream in front of the file's writable: on a cancel we close
 * the file ourselves, whatever state the encoders are in. A file whose writable is still open
 * can't be removed, which is how cancelled exports used to stay behind.
 */
import { settleWithin } from './guard';

export const EXPORT_FILE_PREFIX = 'export-';
/** without Web Locks, files older than this are taken as left over */
export const STALE_EXPORT_MS = 24 * 60 * 60 * 1000;
const lockName = (file: string) => `piano2vision-export-file:${file}`;
/** Chromium keeps a file's unsaved writes in "<name>.crswap" next to it */
const baseName = (entry: string) => entry.replace(/\.crswap$/, '');

export interface ExportFile {
  /** what the muxer writes to ({ type: 'write', position, data } chunks, as a file writable takes) */
  writable: WritableStream;
  /** the finished file (after the muxer has closed `writable`) */
  getFile(): Promise<File>;
  /** stops any writing, closes and removes the file, lets go of its lock; safe to call more than once */
  discard(): Promise<void>;
}

type Root = FileSystemDirectoryHandle;
type Locks = Pick<LockManager, 'request'>;

function locks(): Locks | null {
  return (typeof navigator !== 'undefined' && navigator.locks) || null;
}

/** Holds the lock until the returned function is called (no-op without Web Locks). */
function holdLock(name: string, lm: Locks | null): () => void {
  if (!lm) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  void lm.request(lockName(name), () => held).catch(() => {});
  return release;
}

/** Opens a new export file, or null where OPFS (or writing to it) isn't available. */
export async function openExportFile(ext: string, opts: { root?: Root; locks?: Locks | null; now?: number } = {}): Promise<ExportFile | null> {
  let root: Root | undefined;
  try {
    root = opts.root ?? (await navigator.storage?.getDirectory?.());
  } catch {
    return null;
  }
  if (!root) return null;
  const name = `${EXPORT_FILE_PREFIX}${opts.now ?? Date.now()}.${ext}`;
  const lm = opts.locks === undefined ? locks() : opts.locks;
  const release = holdLock(name, lm);
  let handle: FileSystemFileHandle;
  let inner: WritableStreamDefaultWriter;
  try {
    handle = await root.getFileHandle(name, { create: true });
    const fileWritable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    inner = fileWritable.getWriter();
  } catch {
    await root.removeEntry(name).catch(() => {});
    release();
    return null;
  }
  const dir = root;
  let dead = false;
  let discarded: Promise<void> | null = null;
  // one write at a time, in order (the stream calls write() again only after the last one is done)
  const writable = new WritableStream({
    write: (chunk) => (dead ? Promise.reject(new DOMException('Export canceled', 'AbortError')) : inner.write(chunk)),
    close: () => inner.close(),
    abort: (reason) => inner.abort(reason),
  });
  return {
    writable,
    getFile: () => handle.getFile(),
    discard: () =>
      (discarded ??= (async () => {
        dead = true;
        // throws away unsaved writes; on a finished file (writable closed) this just fails
        await settleWithin(inner.abort(), 1500);
        await settleWithin(dir.removeEntry(name), 1500);
        release();
      })()),
  };
}

/** The time in an export file's name (ms), or NaN. */
export function exportFileTime(entry: string): number {
  const m = /^export-(\d+)\./.exec(entry);
  return m ? Number(m[1]) : NaN;
}

/**
 * Removes export files no tab is using any more (exports are downloaded, not kept): the ones
 * whose lock is free, or, without Web Locks, the ones older than a day. Returns how many were removed.
 */
export async function cleanupExportFiles(opts: { root?: Root; locks?: Locks | null; now?: number } = {}): Promise<number> {
  let removed = 0;
  try {
    const root = opts.root ?? (await navigator.storage?.getDirectory?.());
    if (!root) return 0;
    const lm = opts.locks === undefined ? locks() : opts.locks;
    const now = opts.now ?? Date.now();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) if (name.startsWith(EXPORT_FILE_PREFIX)) names.push(name);
    for (const name of names) {
      const remove = async () => {
        try {
          await root.removeEntry(name);
          removed++;
        } catch {
          /* still open somewhere: next time */
        }
      };
      if (lm) await lm.request(lockName(baseName(name)), { ifAvailable: true }, async (lock) => (lock ? remove() : undefined));
      else if (!(now - exportFileTime(name) < STALE_EXPORT_MS)) await remove();
    }
  } catch {
    /* ignore */
  }
  return removed;
}
