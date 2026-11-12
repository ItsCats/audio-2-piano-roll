/// <reference lib="webworker" />
/**
 * Dedicated module worker: the ByteDance piano transcription note model (Kong et al. 2021; ONNX with
 * float16-stored weights, public/models/piano-specialist/) on onnxruntime-web (WASM EP).
 *
 * Segments the 16 kHz input exactly like piano_transcription_inference 0.0.6 (zero-pad to 10 s
 * multiples, 10 s windows every 5 s, keep the middle halves; protocol.ts) and returns the four
 * deframed output maps. The session is kept between jobs unless the request says `release`
 * (index.ts also terminates the worker after an idle spell: a WASM memory never shrinks while its
 * instance lives, so only terminating the worker gives the ~600 MB back).
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { PTI_OUTPUTS, PTI_PITCHES, PTI_SEGMENT_FRAMES, PTI_SEGMENT_SAMPLES, deframedLength, downloadFailedMessage, placeSegment, planSegments, segmentInput } from './protocol';
import type { ProgressMessage, RunRequest, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);
const CACHE_PREFIX = 'piano2vision-piano-specialist-';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Model bytes from the Cache API (stored whole under `url`, keyed by the sha256) or the network, with
 * download progress. With `parts` the file is fetched as those consecutive pieces (each under Netlify's
 * recommended 10 MB per file) and joined; `url` is then only the cache key. `expectedBytes` is the
 * size used for progress when the server sends no content-length.
 */
async function loadModel(
  url: string,
  parts: string[] | undefined,
  sha256: string | undefined,
  expectedBytes: number,
  onBytes: (loaded: number, total: number) => void,
): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  const cacheName = `${CACHE_PREFIX}${(sha256 ?? 'unchecked').slice(0, 16)}`;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(cacheName);
    // drop caches of older model versions
    for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== cacheName) await caches.delete(k);
  } catch {
    cache = null; // no Cache API (private mode, opaque origin)
  }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (!sha256 || (await sha256Hex(bytes)) === sha256) return { bytes, fromCache: true };
    await cache?.delete(url).catch(() => false);
  }
  const urls = parts?.length ? parts : [url];
  const chunks: Uint8Array[] = [];
  let got = 0;
  let last = 0;
  for (const u of urls) {
    let res: Response;
    try {
      res = await fetch(u);
    } catch (err) {
      throw new Error(downloadFailedMessage(expectedBytes), { cause: err });
    }
    if (!res.ok || !res.body) throw new Error(`Could not download the piano model (HTTP ${res.status}). Try again later, or use the normal model.`);
    const len = Number(res.headers.get('content-length')) || 0;
    const total = urls.length === 1 && len ? len : expectedBytes;
    const reader = res.body.getReader();
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        // the connection dropped part-way through
        throw new Error(downloadFailedMessage(expectedBytes), { cause: err });
      }
      const { done, value } = step;
      if (done) break;
      chunks.push(value);
      got += value.length;
      const now = performance.now();
      if (now - last > 100) {
        last = now;
        onBytes(got, Math.max(total, got));
      }
    }
  }
  onBytes(got, got);
  const bytes = await new Blob(chunks as BlobPart[]).arrayBuffer();
  chunks.length = 0;
  if (sha256 && (await sha256Hex(bytes)) !== sha256) throw new Error('The piano model download was corrupted. Please try again.');
  if (cache) await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => undefined);
  return { bytes, fromCache: false };
}

let session: ort.InferenceSession | null = null;
let sessionKey = '';
let sessionThreads = 1;

async function getSession(req: RunRequest, progress: (m: Omit<ProgressMessage, 'type' | 'jobId'>) => void) {
  const url = req.modelUrl;
  if (!url) throw new Error('No model URL.');
  const wanted = self.crossOriginIsolated ? Math.max(1, Math.min(8, req.threads ?? 1)) : 1;
  const key = `${url}|${wanted}`;
  if (session && sessionKey === key) return { s: session, fromCache: true, reused: true, loadMs: 0, createMs: 0 };
  if (session) {
    await session.release().catch(() => undefined);
    session = null;
  }
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
  // threads need cross-origin isolation (SharedArrayBuffer), see src/lib/isolation.ts. onnxruntime-web
  // reads numThreads when its WASM module first loads, so a worker keeps the count of its first job.
  ort.env.wasm.numThreads = wanted;
  ort.env.wasm.proxy = false;
  progress({ stage: 'loading-model', progress: 0, loaded: 0, total: 0 });
  const { bytes, fromCache } = await loadModel(url, req.modelParts, req.modelSha256, req.modelBytes ?? 0, (loaded, total) =>
    progress({ stage: 'loading-model', progress: total > 0 ? 0.9 * Math.min(1, loaded / total) : 0, loaded, total }),
  );
  const t1 = performance.now();
  progress({ stage: 'loading-model', progress: 0.9 });
  const s = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    // as for SCNet: the arena / memory patterns only raise the peak WASM heap
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  const t2 = performance.now();
  progress({ stage: 'loading-model', progress: 1 });
  session = s;
  sessionKey = key;
  sessionThreads = Math.max(1, ort.env.wasm.numThreads ?? wanted);
  return { s, fromCache, reused: false, loadMs: t1 - t0, createMs: t2 - t1 };
}

async function run(req: RunRequest): Promise<void> {
  const t0 = performance.now();
  const { jobId } = req;
  const progress = (m: Omit<ProgressMessage, 'type' | 'jobId'>) => post({ type: 'progress', jobId, ...m });
  const { s, fromCache, reused, loadMs, createMs } = await getSession(req, progress);
  const audio = req.audio16k;
  const { starts } = planSegments(audio.length);
  const N = starts.length;
  const nFrames = deframedLength(N);
  const outs = PTI_OUTPUTS.map(() => new Float32Array(nFrames * PTI_PITCHES));
  const input = new Float32Array(PTI_SEGMENT_SAMPLES);
  const inName = s.inputNames[0];
  progress({ stage: 'analyzing', progress: 0, done: 0, segments: N });
  let inferMs = 0;
  for (let i = 0; i < N; i++) {
    segmentInput(audio, starts[i], input);
    const tensor = new ort.Tensor('float32', input, [1, PTI_SEGMENT_SAMPLES]);
    const ti = performance.now();
    const res = await s.run({ [inName]: tensor });
    inferMs += performance.now() - ti;
    PTI_OUTPUTS.forEach((name, k) => {
      const t = res[name];
      const data = t.data as Float32Array;
      if (data.length !== PTI_SEGMENT_FRAMES * PTI_PITCHES) throw new Error(`Unexpected model output ${name} [${t.dims.join(', ')}].`);
      placeSegment(outs[k], data, i, N);
      t.dispose();
    });
    progress({ stage: 'analyzing', progress: (i + 1) / N, done: i + 1, segments: N });
  }
  const threads = sessionThreads;
  if (req.release) {
    await session?.release().catch(() => undefined);
    session = null;
    sessionKey = '';
  }
  const [frame, onset, offset, velocity] = outs;
  post(
    {
      type: 'result',
      jobId,
      nFrames,
      fps: 100,
      frame,
      onset,
      offset,
      velocity,
      ms: performance.now() - t0,
      threads,
      stats: { fromCache, reusedSession: reused, loadMs, createMs, inferMs, segments: N },
    },
    outs.map((o) => o.buffer),
  );
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
        await session?.release().catch(() => undefined);
        session = null;
        sessionKey = '';
        post({ type: 'error', jobId: req.jobId, message: err instanceof Error ? err.message : String(err) });
      }),
    );
  };
}
