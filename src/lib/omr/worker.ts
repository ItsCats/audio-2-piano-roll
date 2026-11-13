/// <reference lib="webworker" />
/**
 * Dedicated module worker: reads sheet music from page images (src/lib/omr). Per page: straighten and
 * clean (page.ts), find the staves and the piano systems (staves.ts), then run the Sheet Music
 * Transformer (Ríos-Vila, Calvo-Zaragoza, Paquet; MIT; public/models/omr/README.md) on each system:
 * the encoder once per system image, then the decoder one token at a time with its key/value cache
 * (greedy). Returns the **kern of every system; index.ts turns it into MusicXML.
 *
 * Runs on onnxruntime-web's WASM backend, multi-threaded on cross-origin-isolated pages
 * (src/lib/isolation.ts). The sessions are kept between jobs unless the request says `release`; the
 * page terminates an idle worker (a WASM memory never shrinks while its worker lives).
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { preparePage } from './page';
import { findStaves, groupSystems, modelInput, systemImage } from './staves';
import { bekernToKern } from './kern';
import { MAX_STEPS, downloadFailedMessage } from './protocol';
import type { ModelFile, ModelSpec, PageResult, ProgressMessage, RunRequest, SystemResult, WorkerRequest, WorkerResponse } from './protocol';
import type { Gray } from './image';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse) => self.postMessage(msg);
const CACHE_PREFIX = 'piano2vision-omr-';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Model files from the Cache API (stored whole, sha256-checked) or the network, with byte progress. */
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
  enc: ort.InferenceSession;
  dec: ort.InferenceSession;
  vocab: string[];
  bos: number;
  eos: number;
  threads: number;
}
let loaded: Loaded | null = null;

async function releaseSessions() {
  const l = loaded;
  loaded = null;
  if (!l) return;
  await l.enc.release().catch(() => undefined);
  await l.dec.release().catch(() => undefined);
}

async function getModel(req: RunRequest, progress: (m: Omit<ProgressMessage, 'type' | 'jobId'>) => void) {
  const spec: ModelSpec = req.model;
  const wanted = self.crossOriginIsolated ? Math.max(1, Math.min(8, req.threads)) : 1;
  const key = `${spec.encoder.url}|${spec.decoder.url}|${wanted}`;
  if (loaded && loaded.key === key) return { m: loaded, fromCache: true, reused: true, loadMs: 0, createMs: 0 };
  await releaseSessions();
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
  // onnxruntime-web reads numThreads when its WASM module first loads, so a worker keeps its first count
  ort.env.wasm.numThreads = wanted;
  ort.env.wasm.proxy = false;
  let cache: Cache | null = null;
  const cacheName = `${CACHE_PREFIX}${spec.name}`;
  try {
    cache = await caches.open(cacheName);
  } catch {
    cache = null; // no Cache API (private mode, opaque origin)
  }
  const files = [spec.vocab, spec.encoder, spec.decoder];
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
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < files.length; i++) {
    const r = await loadFile(files[i], cache, (n) => ((done[i] = n), report()));
    fromCache &&= r.fromCache;
    out.push(r.bytes);
  }
  if (cache) {
    // drop entries of older model versions
    const keep = new Set(files.map((f) => new URL(f.url, self.location.href).href));
    for (const r of await cache.keys().catch(() => [] as Request[])) if (!keep.has(r.url)) await cache.delete(r).catch(() => false);
  }
  const t1 = performance.now();
  progress({ stage: 'loading-model', progress: 0.92, loaded: total, total });
  const vocab = JSON.parse(new TextDecoder().decode(out[0])) as string[];
  const opts: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
  };
  const enc = await ort.InferenceSession.create(new Uint8Array(out[1]), opts);
  const dec = await ort.InferenceSession.create(new Uint8Array(out[2]), opts);
  out.length = 0;
  const t2 = performance.now();
  progress({ stage: 'loading-model', progress: 1, loaded: total, total });
  const bos = vocab.indexOf('<bos>');
  const eos = vocab.indexOf('<eos>');
  if (bos < 0 || eos < 0) throw new Error('The sheet-music reader files do not match.');
  loaded = { key, enc, dec, vocab, bos, eos, threads: Math.max(1, ort.env.wasm.numThreads ?? wanted) };
  return { m: loaded, fromCache, reused: false, loadMs: t1 - t0, createMs: t2 - t1 };
}

/**
 * Greedy decoding with the key/value cache. Stops at <eos>, at MAX_STEPS, or when the output has far
 * more bar lines than the image (a model stuck repeating itself).
 */
async function transcribe(m: Loaded, img: Gray, barlines: number): Promise<{ tokens: string[]; finished: boolean; encMs: number; decMs: number }> {
  const t0 = performance.now();
  const image = new ort.Tensor('float32', modelInput(img), [1, 1, img.h, img.w]);
  const encOut = await m.enc.run({ image });
  const crossK = encOut.cross_k;
  const crossV = encOut.cross_v;
  const t1 = performance.now();
  const nL = crossK.dims[0];
  const heads = crossK.dims[1];
  const dh = crossK.dims[3];
  let pastK = new ort.Tensor('float32', new Float32Array(0), [nL, heads, 0, dh]);
  let pastV = new ort.Tensor('float32', new Float32Array(0), [nL, heads, 0, dh]);
  const token = new BigInt64Array(1);
  const pos = new BigInt64Array(1);
  let tok = m.bos;
  const tokens: string[] = [];
  const maxBars = barlines > 0 ? Math.max(10, 2 * barlines + 4) : Infinity;
  let bars = 0;
  let finished = false;
  for (let i = 0; i < MAX_STEPS; i++) {
    token[0] = BigInt(tok);
    pos[0] = BigInt(i);
    const r = await m.dec.run({
      token: new ort.Tensor('int64', token, [1, 1]),
      pos: new ort.Tensor('int64', pos, [1]),
      past_k: pastK,
      past_v: pastV,
      cross_k: crossK,
      cross_v: crossV,
    });
    const lg = r.logits.data as Float32Array;
    let best = 0;
    let bv = lg[0];
    for (let j = 1; j < lg.length; j++) if (lg[j] > bv) (bv = lg[j]), (best = j);
    r.logits.dispose();
    if (i > 0) {
      pastK.dispose();
      pastV.dispose();
    }
    pastK = r.next_k as ort.TypedTensor<'float32'>;
    pastV = r.next_v as ort.TypedTensor<'float32'>;
    tok = best;
    if (tok === m.eos) {
      finished = true;
      break;
    }
    const w = m.vocab[tok] ?? '';
    if (w.startsWith('=') && (tokens.length === 0 || tokens[tokens.length - 1] === '<b>') && ++bars > maxBars) break;
    tokens.push(w);
  }
  pastK.dispose();
  pastV.dispose();
  crossK.dispose();
  crossV.dispose();
  return { tokens, finished, encMs: t1 - t0, decMs: performance.now() - t1 };
}

async function run(req: RunRequest): Promise<void> {
  const { jobId } = req;
  const progress = (m: Omit<ProgressMessage, 'type' | 'jobId'>) => post({ type: 'progress', jobId, ...m });
  const { m, fromCache, reused, loadMs, createMs } = await getModel(req, progress);
  // 1. find the lines of music on every page (keeps only the small system images)
  const tp = performance.now();
  const jobs: { page: number; img: Gray; box: SystemResult['box']; barlines: number }[] = [];
  const pages: PageResult[] = [];
  const nPages = req.pages.length;
  for (let p = 0; p < nPages; p++) {
    progress({ stage: 'finding-lines', progress: p / nPages, page: p, pages: nPages });
    const src = req.pages[p];
    const { page, quad } = preparePage({ w: src.w, h: src.h, d: src.data }, { quad: src.quad ?? null, findPage: req.findPage });
    req.pages[p] = { w: 0, h: 0, data: new Uint8Array(0) }; // let the original go
    const finding = findStaves(page);
    const systems = groupSystems(page, finding);
    for (const s of systems) jobs.push({ page: p, img: systemImage(page, s), box: { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 }, barlines: s.barlines });
    pages.push({ staves: finding.staves.length, systems: systems.length, w: page.w, h: page.h, quad });
  }
  const prepareMs = performance.now() - tp;
  // 2. read them
  const out: SystemResult[] = [];
  let encodeMs = 0;
  let decodeMs = 0;
  let steps = 0;
  progress({ stage: 'reading', progress: 0, line: 0, lines: jobs.length });
  for (let k = 0; k < jobs.length; k++) {
    const j = jobs[k];
    const t = performance.now();
    const r = await transcribe(m, j.img, j.barlines);
    encodeMs += r.encMs;
    decodeMs += r.decMs;
    steps += r.tokens.length;
    out.push({ page: j.page, kern: bekernToKern(r.tokens), steps: r.tokens.length, finished: r.finished, box: j.box, barlines: j.barlines, ms: performance.now() - t });
    jobs[k].img = { w: 0, h: 0, d: new Uint8Array(0) };
    progress({ stage: 'reading', progress: (k + 1) / jobs.length, line: k + 1, lines: jobs.length });
  }
  const threads = m.threads;
  if (req.release) await releaseSessions();
  post({
    type: 'result',
    jobId,
    systems: out,
    pages,
    stats: { fromCache, reusedSession: reused, loadMs, createMs, prepareMs, encodeMs, decodeMs, steps, threads },
  });
}

// onnxruntime-web starts its WASM threads as copies of this script (worker name em-pthread…); its own
// message handler must stay in place there.
if (!(self.name ?? '').startsWith('em-pthread')) {
  // one job at a time, in order
  let queue: Promise<void> = Promise.resolve();
  self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    const req = e.data;
    if (req?.type !== 'run') return;
    queue = queue.then(() =>
      run(req).catch(async (err) => {
        await releaseSessions();
        post({ type: 'error', jobId: req.jobId, message: err instanceof Error ? err.message : String(err) });
      }),
    );
  };
}
