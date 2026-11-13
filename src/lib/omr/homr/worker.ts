/// <reference lib="webworker" />
/**
 * Dedicated module worker: the homr sheet-music reader (src/lib/omr/homr, derived from homr,
 * AGPL-3.0, https://github.com/liebharc/homr). Loads homr's three networks (segmentation, transformer
 * encoder and decoder; public/models/homr/) on onnxruntime-web's WASM backend, multi-threaded on
 * cross-origin-isolated pages, then reads the pages one at a time and returns their MusicXML.
 *
 * The sessions are kept between jobs unless the request says `release`; in low-memory mode (phones)
 * only the networks of the current step exist (ort.ts stagedInfer). The page terminates an idle worker
 * (a WASM memory never shrinks while its worker lives).
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { expandFp16Weights } from './fp16w';
import { ortInfer, stagedInfer, type HomrSessions, type InferStats, type SessionName } from './ort';
import { pageImage, rotate90, shrinkPixels, straighten } from './page';
import { NoMusicError, pagesToMusicXml, readPage, SEG_BATCH, type HomrInfer, type PageProgress } from './pipeline';
import { downloadFailedMessage, PlainError } from './protocol';
import type { HomrModelSpec, HomrPageResult, ModelFile, PageInput, ProgressMessage, Quad, RunRequest, WorkerRequest, WorkerResponse } from './protocol';
import type { El } from './xml';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse) => self.postMessage(msg);
const CACHE_NAME = 'piano2vision-homr';

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** cache keys whose content was sha256-checked by this worker (not hashed again when read back) */
const verified = new Set<string>();

interface FileBytes {
  bytes: Uint8Array;
  fromCache: boolean;
  /** in Cache Storage now (it can be read back from there instead of being kept in memory) */
  stored: boolean;
}

/** A model file from the Cache API (stored whole, sha256-checked) or the network (in pieces), with byte progress. */
async function loadFile(file: ModelFile, cache: Cache | null, onBytes: (n: number) => void): Promise<FileBytes> {
  const hit = cache ? await cache.match(file.url).catch(() => undefined) : undefined;
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (!file.sha256 || verified.has(file.url) || (await sha256Hex(bytes)) === file.sha256) {
      verified.add(file.url);
      return { bytes, fromCache: true, stored: true };
    }
    verified.delete(file.url);
    await cache?.delete(file.url).catch(() => false);
  }
  const urls = file.parts?.length ? file.parts : [file.url];
  // one buffer of the expected size, filled as the pieces arrive (no list of chunks + joined copy)
  let bytes = new Uint8Array(file.bytes);
  let got = 0;
  for (const u of urls) {
    let res: Response;
    try {
      res = await fetch(u);
    } catch (err) {
      throw new PlainError(downloadFailedMessage(file.bytes), { cause: err });
    }
    if (!res.ok || !res.body) throw new PlainError(`Could not download the sheet-music reader (HTTP ${res.status}). Try again later.`);
    const reader = res.body.getReader();
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        throw new PlainError(downloadFailedMessage(file.bytes), { cause: err });
      }
      if (step.done) break;
      if (got + step.value.length > bytes.length) {
        // more than announced (test harness specs without a size): grow
        const grown = new Uint8Array(Math.max(2 * bytes.length, got + step.value.length));
        grown.set(bytes.subarray(0, got));
        bytes = grown;
      }
      bytes.set(step.value, got);
      got += step.value.length;
      onBytes(got);
    }
  }
  if (got !== bytes.length) bytes = bytes.slice(0, got);
  if (file.sha256 && (await sha256Hex(bytes)) !== file.sha256) throw new PlainError('The sheet-music reader download was corrupted. Please try again.');
  let stored = false;
  if (cache) {
    try {
      await cache.put(file.url, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/octet-stream' } }));
      stored = true;
      verified.add(file.url);
    } catch {
      stored = false; // quota, private mode: read from memory this time, downloaded again next time
    }
  }
  return { bytes, fromCache: false, stored };
}

const NAMES = ['segnet', 'encoder', 'decoder'] as const;
const BASE_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
  // the arena and memory patterns only raise the peak WASM heap
  enableCpuMemArena: false,
  enableMemPattern: false,
};

/** A session from the model bytes (float16-stored weights expanded first, see fp16w.ts). */
function createSession(name: SessionName, bytes: Uint8Array): Promise<ort.InferenceSession> {
  // the decoder steps one token at a time (tiny matrix products): extra threads only cost
  // synchronisation there (measured: 33 s with one thread vs 41 s with three on a 5-system page)
  const o = name === 'decoder' ? { ...BASE_OPTIONS, intraOpNumThreads: 1 } : BASE_OPTIONS;
  return ort.InferenceSession.create(expandFp16Weights(bytes), o);
}

/** The networks of a job: all three kept (desktops), or created step by step (low-memory mode). */
interface Engine {
  key: string;
  infer: (stats: InferStats) => HomrInfer;
  release(): Promise<void>;
  threads: number;
}
let loaded: Engine | null = null;
let ortReady: number | null = null;

async function releaseSessions(): Promise<void> {
  const l = loaded;
  loaded = null;
  await l?.release().catch(() => undefined);
}

interface Loading {
  l: Engine;
  fromCache: boolean;
  reused: boolean;
  loadMs: number;
  createMs: number;
  notStored: boolean;
}

async function getEngine(req: RunRequest, progress: (m: Omit<ProgressMessage, 'type' | 'jobId'>) => void): Promise<Loading> {
  const spec: HomrModelSpec = req.model;
  const wanted = self.crossOriginIsolated ? Math.max(1, Math.min(8, req.threads)) : 1;
  const low = !!req.lowMemory;
  const key = `${spec.segnet.url}|${spec.encoder.url}|${spec.decoder.url}|${wanted}|${low}`;
  if (loaded && loaded.key === key) return { l: loaded, fromCache: true, reused: true, loadMs: 0, createMs: 0, notStored: false };
  await releaseSessions();
  if (ortReady === null) {
    ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
    // onnxruntime-web reads numThreads when its WASM module first loads, so a worker keeps its first count
    ort.env.wasm.numThreads = wanted;
    ort.env.wasm.proxy = false;
    ortReady = wanted;
  }
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    cache = null; // no Cache API (private mode, opaque origin)
  }
  const files = [spec.segnet, spec.encoder, spec.decoder];
  // `total` counts only what has to be downloaded: 0 means everything comes from the cache (the
  // import screen then says "Starting the reader" instead of "Downloading")
  const cached = await Promise.all(files.map(async (f) => !!cache && !!(await cache.match(f.url).catch(() => undefined))));
  const total = files.reduce((a, f, i) => a + (cached[i] ? 0 : f.bytes), 0);
  const weight = files.map((f) => f.bytes / files.reduce((a, g) => a + g.bytes, 0));
  const done = [0, 0, 0];
  let last = 0;
  const report = (i: number, within: number) => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    const before = weight.slice(0, i).reduce((a, b) => a + b, 0);
    const got = done.reduce((a, b) => a + b, 0);
    progress({ stage: 'loading-model', progress: 0.95 * Math.min(1, before + weight[i] * within), loaded: total ? got : 0, total });
  };
  progress({ stage: 'loading-model', progress: 0, loaded: 0, total });
  let fromCache = true;
  let notStored = false;
  let loadMs = 0;
  let createMs = 0;
  let l: Engine;
  if (!low) {
    const sessions: Partial<HomrSessions> = {};
    try {
      for (let i = 0; i < files.length; i++) {
        // one file at a time: its bytes are dropped once its session exists (lower peak memory)
        const ta = performance.now();
        const r = await loadFile(files[i], cache, (n) => ((done[i] = n), report(i, cached[i] ? 0.5 : (0.8 * n) / files[i].bytes)));
        fromCache &&= r.fromCache;
        notStored ||= !r.stored;
        const tb = performance.now();
        sessions[NAMES[i]] = await createSession(NAMES[i], r.bytes);
        loadMs += tb - ta;
        createMs += performance.now() - tb;
        report(i, 1);
      }
    } catch (err) {
      for (const s of Object.values(sessions)) await s?.release().catch(() => undefined);
      throw err;
    }
    const all = sessions as HomrSessions;
    l = {
      key,
      threads: Math.max(1, ort.env.wasm.numThreads ?? wanted),
      infer: (stats) => ortInfer(ort, all, stats),
      release: async () => {
        for (const s of Object.values(all)) await s.release().catch(() => undefined);
      },
    };
  } else {
    // download / check all three now; sessions are made when their step comes (stagedInfer). Files in
    // Cache Storage are read back from there each time instead of being kept in memory.
    const kept: Partial<Record<SessionName, Uint8Array>> = {};
    for (let i = 0; i < files.length; i++) {
      const ta = performance.now();
      const r = await loadFile(files[i], cache, (n) => ((done[i] = n), report(i, n / files[i].bytes)));
      fromCache &&= r.fromCache;
      notStored ||= !r.stored;
      if (!r.stored) kept[NAMES[i]] = r.bytes;
      loadMs += performance.now() - ta;
      report(i, 1);
    }
    const bytesOf = async (name: SessionName): Promise<Uint8Array> => {
      const k = kept[name];
      if (k) return k;
      const f = spec[name];
      return (await loadFile(f, cache, () => undefined)).bytes;
    };
    let staged: ReturnType<typeof stagedInfer> | null = null;
    l = {
      key,
      threads: Math.max(1, ort.env.wasm.numThreads ?? wanted),
      infer: (stats) => {
        staged = stagedInfer(ort, async (name) => createSession(name, await bytesOf(name)), stats);
        return staged;
      },
      release: async () => {
        await staged?.release();
        staged = null;
      },
    };
  }
  if (cache) {
    // drop entries of older model versions (only in the folders of these models: a test spec elsewhere keeps the shipped ones)
    const dir = (u: string) => new URL(u, self.location.href).pathname.replace(/[^/]*$/, '');
    const keep = new Set(files.map((f) => new URL(f.url, self.location.href).href));
    const dirs = new Set(files.map((f) => dir(f.url)));
    for (const r of await cache.keys().catch(() => [] as Request[])) if (!keep.has(r.url) && dirs.has(dir(r.url))) await cache.delete(r).catch(() => false);
  }
  progress({ stage: 'loading-model', progress: 1, loaded: total, total });
  loaded = l;
  return { l, fromCache, reused: false, loadMs, createMs, notStored };
}

/** Reads one page; a sideways page (landscape, nothing found) is tried again turned both ways. */
async function readOne(input: PageInput, infer: HomrInfer, segBatch: number, onProgress: (p: PageProgress) => void) {
  let image = pageImage(fitInput(input));
  if (input.quad) image = straighten(image, scaleQuad(input.quad, input, image));
  const turns = image.w > image.h ? ([0, 90, 270] as const) : ([0] as const);
  let first: unknown = null;
  for (const deg of turns) {
    const im = deg ? rotate90(image, deg) : image;
    try {
      const r = await readPage(im, infer, { segBatch, onProgress });
      return { r, rotated: deg };
    } catch (err) {
      if (!(err instanceof NoMusicError) || err.kind !== 'no-music') throw err;
      first ??= err;
    }
  }
  throw first;
}

/** The page's pixels, scaled down to MAX_INPUT_SIDE if larger (the page normally did that already). */
function fitInput(p: PageInput): PageInput {
  const s = shrinkPixels(p.data, p.w, p.h, p.channels);
  return s.w === p.w ? p : { ...p, w: s.w, h: s.h, data: s.data };
}

function scaleQuad(q: Quad, from: PageInput, to: { w: number; h: number }): Quad {
  const fx = to.w / from.w;
  const fy = to.h / from.h;
  if (fx === 1 && fy === 1) return q;
  return q.map(([x, y]) => [x * fx, y * fy]) as Quad;
}

async function run(req: RunRequest): Promise<void> {
  const { jobId } = req;
  const progress = (m: Omit<ProgressMessage, 'type' | 'jobId'>) => post({ type: 'progress', jobId, ...m });
  const { l, fromCache, reused, loadMs, createMs, notStored } = await getEngine(req, progress);
  const stats: InferStats = { segmentMs: 0, encodeMs: 0, decodeMs: 0, steps: 0, windows: 0, staffs: 0 };
  const infer = l.infer(stats);
  const results: HomrPageResult[] = [];
  const trees: El[] = [];
  const n = req.pageCount;
  const segBatch = req.lowMemory ? 1 : SEG_BATCH;
  for (let i = 0; i < n; i++) {
    const input = await nextPage(jobId, i);
    const t0 = performance.now();
    try {
      const { r, rotated } = await readOne(input, infer, segBatch, (p) => {
        if (p.stage === 'reading') progress({ stage: 'reading', progress: p.progress, page: i, pages: n, line: p.staff, lines: p.staffs });
        else progress({ stage: 'finding-lines', progress: p.stage === 'segmenting' ? 0.9 * p.progress : 0.95, page: i, pages: n });
      });
      trees.push(r.xml);
      results.push({ staves: r.staffs, systems: r.systems, ms: performance.now() - t0, ...(rotated ? { rotated } : {}) });
    } catch (err) {
      if (!(err instanceof NoMusicError)) throw err;
      results.push({ staves: 0, systems: 0, error: err.message, errorKind: err.kind, ms: performance.now() - t0 });
    }
  }
  const threads = l.threads;
  if (req.release || req.lowMemory) await releaseSessions();
  post({
    type: 'result',
    jobId,
    musicXml: trees.length ? pagesToMusicXml(trees, req.title) : '',
    pages: results,
    stats: {
      fromCache,
      reusedSession: reused,
      loadMs,
      createMs,
      segmentMs: stats.segmentMs,
      encodeMs: stats.encodeMs,
      decodeMs: stats.decodeMs,
      steps: stats.steps,
      threads,
      ...(notStored ? { notStored } : {}),
      ...(req.lowMemory ? { lowMemory: true } : {}),
    },
  });
}

/** pages asked for and not yet sent */
const waiting = new Map<string, (p: PageInput) => void>();

function nextPage(jobId: number, index: number): Promise<PageInput> {
  return new Promise((resolve) => {
    waiting.set(`${jobId}:${index}`, resolve);
    post({ type: 'need-page', jobId, index });
  });
}

// onnxruntime-web starts its WASM threads as copies of this script (worker name em-pthread…); its own
// message handler must stay in place there.
if (!(self.name ?? '').startsWith('em-pthread')) {
  // one job at a time, in order
  let queue: Promise<void> = Promise.resolve();
  self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    const req = e.data;
    if (req?.type === 'page') {
      const k = `${req.jobId}:${req.index}`;
      waiting.get(k)?.(req.page);
      waiting.delete(k);
      return;
    }
    if (req?.type !== 'run') return;
    queue = queue.then(() =>
      run(req).catch(async (err) => {
        await releaseSessions();
        post({ type: 'error', jobId: req.jobId, message: err instanceof Error ? err.message : String(err), plain: err instanceof PlainError });
      }),
    );
  };
}
