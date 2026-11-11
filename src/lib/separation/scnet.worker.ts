/// <reference lib="webworker" />
/**
 * Dedicated module worker: SCNet source separation with onnxruntime-web (WASM EP).
 * One worker per separation: the main thread terminates it afterwards, which returns the
 * ~1.2 GB WASM heap to the OS (a WASM memory never shrinks while its instance lives).
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { BINS, FRAMES, SCNET_RATE, decimate2, drumOnsetEnvelope, separateSegments } from './dsp';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Model bytes from the Cache API (keyed by its sha256) or the network, with real download progress. */
async function loadModel(url: string, sha256: string): Promise<{ bytes: ArrayBuffer; fromCache: boolean }> {
  const cacheName = `piano2vision-scnet-${sha256.slice(0, 16)}`;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(cacheName);
    // drop caches of older model versions
    for (const k of await caches.keys()) if (k.startsWith('piano2vision-scnet-') && k !== cacheName) await caches.delete(k);
  } catch {
    cache = null; // no Cache API (private mode, opaque origin)
  }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if ((await sha256Hex(bytes)) === sha256) return { bytes, fromCache: true };
    await cache?.delete(url).catch(() => false);
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not download the separation model (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    post({ type: 'progress', phase: 'download', done: got, total });
  }
  const bytes = await new Blob(parts as BlobPart[]).arrayBuffer();
  if ((await sha256Hex(bytes)) !== sha256) throw new Error('The separation model download was corrupted. Please try again.');
  if (cache) await cache.put(url, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => undefined);
  return { bytes, fromCache: false };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== 'separate') return;
  let session: ort.InferenceSession | null = null;
  try {
    const t0 = performance.now();
    ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
    // threads need cross-origin isolation (SharedArrayBuffer), which this app does not enable
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    ort.env.wasm.proxy = false;
    const { bytes, fromCache } = await loadModel(req.modelUrl, req.modelSha256);
    post({ type: 'progress', phase: 'init', done: 0, total: 1 });
    const t1 = performance.now();
    session = await ort.InferenceSession.create(new Uint8Array(bytes), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      // measured: arena / memory patterns raise the peak WASM heap with no speed gain for this graph
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    const t2 = performance.now();
    const s = session;
    const inName = s.inputNames[0];
    const outName = s.outputNames[0];
    const { left, right } = req;
    const n = left.length;
    const stems = await separateSegments(
      left,
      right,
      [
        { name: 'vocals', stems: [3] },
        { name: 'accomp', stems: [1, 2] },
        // only reduced to an onset envelope below (drum-hit false notes), never returned as audio
        { name: 'drums', stems: [0] },
      ],
      async (spec) => {
        const input = new ort.Tensor('float32', spec, [1, 4, BINS, FRAMES]);
        const out = await s.run({ [inName]: input });
        input.dispose();
        const t = out[outName];
        return { data: t.data as Float32Array, release: () => t.dispose() };
      },
      { step: req.step, onSegment: (done, total) => post({ type: 'progress', phase: 'separate', done, total }) },
    );
    await session.release();
    session = null;
    const t3 = performance.now();

    // mono mixture (same downmix as the stems) for the presence gate, then 44.1 → 22.05 kHz
    const outLen = Math.floor(n / 2);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) * 0.5;
    const mix22 = decimate2(mono, outLen);
    const vocals22 = decimate2(stems.vocals, outLen);
    const accomp22 = decimate2(stems.accomp, outLen);
    const t4 = performance.now();
    const drumOnsets = drumOnsetEnvelope(stems.drums, mono, SCNET_RATE);
    const t5 = performance.now();
    const result: WorkerResponse = {
      type: 'result',
      vocals: vocals22,
      accomp: accomp22,
      mix: mix22,
      drumOnsets,
      vocals44: req.keep44 ? stems.vocals : undefined,
      accomp44: req.keep44 ? stems.accomp : undefined,
      drums44: req.keep44 ? stems.drums : undefined,
      stats: {
        fromCache,
        loadMs: t1 - t0,
        createMs: t2 - t1,
        separateMs: t3 - t2,
        resampleMs: t4 - t3,
        drumsMs: t5 - t4,
        threads: ort.env.wasm.numThreads ?? 1,
        sampleRate: SCNET_RATE,
      },
    };
    const transfer: Transferable[] = [vocals22.buffer, accomp22.buffer, mix22.buffer, drumOnsets.buffer];
    if (req.keep44) transfer.push(stems.vocals.buffer, stems.accomp.buffer, stems.drums.buffer);
    post(result, transfer);
  } catch (err) {
    await session?.release().catch(() => undefined);
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
