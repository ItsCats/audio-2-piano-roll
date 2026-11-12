/// <reference lib="webworker" />
/**
 * Dedicated module worker: CREPE "tiny" pitch tracking with onnxruntime-web (WASM EP).
 * Resamples to 16 kHz, frames + normalises, runs the network on the frames loud enough to be
 * sung, decodes the 360-bin activations with an online Viterbi pass, and returns f0 /
 * periodicity / frame RMS. One worker per call (terminated by the caller afterwards).
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { CREPE_RATE, CREPE_WINDOW, ViterbiDecoder, binRange, frameCount, frameRms, localAverageHz, quantile, resample, writeFrame } from './crepe';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function fetchModel(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the vocal pitch model (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

// onnxruntime-web starts its WASM threads as copies of this script (worker name em-pthread…); its own
// message handler must stay in place there.
if (!(self.name ?? '').startsWith('em-pthread')) self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== 'track') return;
  let session: ort.InferenceSession | null = null;
  try {
    const t0 = performance.now();
    ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    ort.env.wasm.proxy = false;
    post({ type: 'progress', phase: 'load', done: 0, total: 1 });
    const bytes = await fetchModel(req.modelUrl);
    const t1 = performance.now();
    session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const t2 = performance.now();
    post({ type: 'progress', phase: 'load', done: 1, total: 1 });

    const audio = req.sampleRate === CREPE_RATE ? req.audio : resample(req.audio, req.sampleRate, CREPE_RATE);
    const hop = req.hop;
    const n = frameCount(audio.length, hop);
    const rms = frameRms(audio, hop);
    const ref = quantile(rms, 0.95);
    const gate = ref * 10 ** (req.skipDb / 20);
    const index = new Int32Array(n).fill(-1);
    let inferred = 0;
    for (let i = 0; i < n; i++) if (ref > 0 && rms[i] >= gate) index[i] = inferred++;

    const range = binRange(req.fmin, req.fmax);
    const W = range.hi - range.lo;
    const acts = new Uint8Array(inferred * W); // activations of the allowed bins, quantised to 1/255
    const decoder = new ViterbiDecoder(range, n);
    const inName = session.inputNames[0];
    const outName = session.outputNames[0];
    const B = Math.max(1, req.batch);
    const input = new Float32Array(B * CREPE_WINDOW);
    const rowAct = new Float32Array(W);
    let inferMs = 0;
    let decodeMs = 0;
    for (let c = 0; c < n; c += B) {
      const end = Math.min(n, c + B);
      const run: number[] = [];
      for (let i = c; i < end; i++) if (index[i] >= 0) run.push(i);
      let probs: Float32Array | null = null;
      if (run.length) {
        for (let k = 0; k < run.length; k++) writeFrame(audio, run[k], hop, input, k * CREPE_WINDOW);
        const ta = performance.now();
        const tensor = new ort.Tensor('float32', input.subarray(0, run.length * CREPE_WINDOW), [run.length, CREPE_WINDOW]);
        const out = await session.run({ [inName]: tensor });
        tensor.dispose();
        probs = (out[outName].data as Float32Array).slice();
        out[outName].dispose();
        inferMs += performance.now() - ta;
      }
      const tb = performance.now();
      let k = 0;
      for (let i = c; i < end; i++) {
        if (index[i] < 0 || !probs) {
          decoder.step(null);
          continue;
        }
        const off = k * 360 + range.lo;
        for (let b = 0; b < W; b++) rowAct[b] = probs[off + b];
        decoder.step(rowAct);
        const base = index[i] * W;
        for (let b = 0; b < W; b++) acts[base + b] = Math.round(rowAct[b] * 255);
        k++;
      }
      decodeMs += performance.now() - tb;
      post({ type: 'progress', phase: 'infer', done: end, total: n });
    }
    await session.release();
    session = null;

    const tc = performance.now();
    const path = decoder.finish();
    const f0 = new Float32Array(n);
    const periodicity = new Float32Array(n);
    const local = new Float32Array(W);
    for (let i = 0; i < n; i++) {
      const j = index[i];
      if (j < 0) continue;
      const base = j * W;
      for (let b = 0; b < W; b++) local[b] = acts[base + b];
      periodicity[i] = acts[base + path[i] - range.lo] / 255;
      f0[i] = localAverageHz(local, path[i], range);
    }
    decodeMs += performance.now() - tc;
    post(
      {
        type: 'result',
        f0,
        periodicity,
        rms,
        stats: { loadMs: t1 - t0, createMs: t2 - t1, inferMs, decodeMs, frames: n, inferred, threads: ort.env.wasm.numThreads ?? 1 },
      },
      [f0.buffer, periodicity.buffer, rms.buffer],
    );
  } catch (err) {
    await session?.release().catch(() => undefined);
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
