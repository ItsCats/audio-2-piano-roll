/// <reference lib="webworker" />
/**
 * Dedicated module worker: the homr sheet-music reader (src/lib/omr/homr, derived from homr,
 * AGPL-3.0, https://github.com/liebharc/homr). Loads homr's three networks (segmentation, transformer
 * encoder and decoder; public/models/homr/) on onnxruntime-web's WASM backend, multi-threaded on
 * cross-origin-isolated pages, then reads the pages one at a time and returns their MusicXML.
 *
 * The sessions are kept between jobs unless the request says `release` (phones); the page terminates
 * an idle worker (a WASM memory never shrinks while its worker lives).
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { ortInfer, type HomrSessions, type InferStats } from './ort';
import { pageImage, straighten } from './page';
import { NoMusicError, pagesToMusicXml, readPage } from './pipeline';
import { downloadFailedMessage } from './protocol';
import type { HomrModelSpec, HomrPageResult, ModelFile, PageInput, ProgressMessage, RunRequest, WorkerRequest, WorkerResponse } from './protocol';
import type { El } from './xml';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse) => self.postMessage(msg);
const CACHE_NAME = 'piano2vision-homr';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A model file from the Cache API (stored whole, sha256-checked) or the network (in pieces), with byte progress. */
async function loadFile(file: ModelFile, cache: Cache | null, onBytes: (n: number) => void): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  const hit = cache ? await cache.match(file.url).catch(() => undefined) : undefined;
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (!file.sha256 || (await sha256Hex(bytes)) === file.sha256) {
      onBytes(file.bytes);
      return { bytes, fromCache: true };
    }
    await cache?.delete(file.url).catch(() => false);
  }
  const urls = file.parts?.length ? file.parts : [file.url];
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (const u of urls) {
    let res: Response;
    try {
      res = await fetch(u);
    } catch (err) {
      throw new Error(downloadFailedMessage(file.bytes), { cause: err });
    }
    if (!res.ok || !res.body) throw new Error(`Could not download the sheet-music reader (HTTP ${res.status}). Try again later.`);
    const reader = res.body.getReader();
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        throw new Error(downloadFailedMessage(file.bytes), { cause: err });
      }
      if (step.done) break;
      chunks.push(step.value);
      got += step.value.length;
      onBytes(got);
    }
  }
  const bytes = await new Blob(chunks as BlobPart[]).arrayBuffer();
  chunks.length = 0;
  if (file.sha256 && (await sha256Hex(bytes)) !== file.sha256) throw new Error('The sheet-music reader download was corrupted. Please try again.');
  if (cache) await cache.put(file.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => undefined);
  return { bytes, fromCache: false };
}

interface Loaded {
  key: string;
  sessions: HomrSessions;
  threads: number;
}
let loaded: Loaded | null = null;

async function releaseSessions(): Promise<void> {
  const l = loaded;
  loaded = null;
  if (!l) return;
  for (const s of Object.values(l.sessions)) await s.release().catch(() => undefined);
}

async function getSessions(req: RunRequest, progress: (m: Omit<ProgressMessage, 'type' | 'jobId'>) => void) {
  const spec: HomrModelSpec = req.model;
  const wanted = self.crossOriginIsolated ? Math.max(1, Math.min(8, req.threads)) : 1;
  const key = `${spec.segnet.url}|${spec.encoder.url}|${spec.decoder.url}|${wanted}`;
  if (loaded && loaded.key === key) return { l: loaded, fromCache: true, reused: true, loadMs: 0, createMs: 0 };
  await releaseSessions();
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
  // onnxruntime-web reads numThreads when its WASM module first loads, so a worker keeps its first count
  ort.env.wasm.numThreads = wanted;
  ort.env.wasm.proxy = false;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    cache = null; // no Cache API (private mode, opaque origin)
  }
  const files = [spec.segnet, spec.encoder, spec.decoder];
  const total = files.reduce((a, f) => a + f.bytes, 0);
  const done = [0, 0, 0];
  let last = 0;
  progress({ stage: 'loading-model', progress: 0, loaded: 0, total });
  const report = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    const got = done.reduce((a, b) => a + b, 0);
    progress({ stage: 'loading-model', progress: 0.9 * Math.min(1, got / total), loaded: got, total });
  };
  let fromCache = true;
  const opts: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    // the arena and memory patterns only raise the peak WASM heap
    enableCpuMemArena: false,
    enableMemPattern: false,
  };
  const sessions: Partial<HomrSessions> = {};
  const names = ['segnet', 'encoder', 'decoder'] as const;
  let loadMs = 0;
  let createMs = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      // one file at a time: its bytes are dropped once its session exists (lower peak memory)
      const ta = performance.now();
      const r = await loadFile(files[i], cache, (n) => ((done[i] = n), report()));
      fromCache &&= r.fromCache;
      const tb = performance.now();
      // the decoder steps one token at a time (tiny matrix products): extra threads only cost
      // synchronisation there (measured: 33 s with one thread vs 41 s with three on a 5-system page)
      const o = names[i] === 'decoder' ? { ...opts, intraOpNumThreads: 1 } : opts;
      sessions[names[i]] = await ort.InferenceSession.create(new Uint8Array(r.bytes), o);
      loadMs += tb - ta;
      createMs += performance.now() - tb;
    }
  } catch (err) {
    for (const s of Object.values(sessions)) await s?.release().catch(() => undefined);
    throw err;
  }
  if (cache) {
    // drop entries of older model versions
    const keep = new Set(files.map((f) => new URL(f.url, self.location.href).href));
    for (const r of await cache.keys().catch(() => [] as Request[])) if (!keep.has(r.url)) await cache.delete(r).catch(() => false);
  }
  progress({ stage: 'loading-model', progress: 1, loaded: total, total });
  const l: Loaded = { key, sessions: sessions as HomrSessions, threads: Math.max(1, ort.env.wasm.numThreads ?? wanted) };
  loaded = l;
  void t0;
  return { l, fromCache, reused: false, loadMs, createMs };
}

async function run(req: RunRequest): Promise<void> {
  const { jobId } = req;
  const progress = (m: Omit<ProgressMessage, 'type' | 'jobId'>) => post({ type: 'progress', jobId, ...m });
  const { l, fromCache, reused, loadMs, createMs } = await getSessions(req, progress);
  const stats: InferStats = { segmentMs: 0, encodeMs: 0, decodeMs: 0, steps: 0, windows: 0, staffs: 0 };
  const infer = ortInfer(ort, l.sessions, stats);
  const results: HomrPageResult[] = [];
  const trees: El[] = [];
  const n = req.pageCount;
  for (let i = 0; i < n; i++) {
    const input = await nextPage(jobId, i);
    const t0 = performance.now();
    let image = pageImage(input);
    if (input.quad) image = straighten(image, input.quad);
    try {
      const r = await readPage(image, infer, {
        onProgress: (p) => {
          if (p.stage === 'reading') progress({ stage: 'reading', progress: p.progress, page: i, pages: n, line: p.staff, lines: p.staffs });
          else progress({ stage: 'finding-lines', progress: p.stage === 'segmenting' ? 0.9 * p.progress : 0.95, page: i, pages: n });
        },
      });
      trees.push(r.xml);
      results.push({ staves: r.staffs, systems: r.systems, ms: performance.now() - t0 });
    } catch (err) {
      if (!(err instanceof NoMusicError)) throw err;
      results.push({ staves: 0, systems: 0, error: err.message, ms: performance.now() - t0 });
    }
  }
  const threads = l.threads;
  if (req.release) await releaseSessions();
  post({
    type: 'result',
    jobId,
    musicXml: trees.length ? pagesToMusicXml(trees, req.title) : '',
    pages: results,
    stats: { fromCache, reusedSession: reused, loadMs, createMs, segmentMs: stats.segmentMs, encodeMs: stats.encodeMs, decodeMs: stats.decodeMs, steps: stats.steps, threads },
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
        post({ type: 'error', jobId: req.jobId, message: err instanceof Error ? err.message : String(err) });
      }),
    );
  };
}
