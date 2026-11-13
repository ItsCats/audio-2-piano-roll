/// <reference lib="webworker" />
/*
 * SPDX-License-Identifier: AGPL-3.0-or-later AND Apache-2.0
 * The audio windowing and overlap trimming around the model are derived from the inference code of
 * spotify/basic-pitch (https://github.com/spotify/basic-pitch), Copyright 2022 Spotify AB,
 * licensed under the Apache License, Version 2.0 (full text: public/models/basic-pitch/LICENSE).
 * Modified: rewritten in TypeScript by the Piano2Vision authors.
 */
/**
 * Transcription worker: runs the Basic Pitch neural network (Spotify, Apache-2.0) with
 * TensorFlow.js off the main thread and extracts notes from its output.
 */
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import '@tensorflow/tfjs-backend-webgl';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import wasmPlain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import wasmSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreaded from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import {
  BP_HOP_SAMPLES,
  BP_KEPT_FRAMES,
  BP_N_PITCHES,
  BP_OVERLAP_HALF,
  BP_OVERLAP_SAMPLES,
  BP_SAMPLE_RATE,
  BP_WINDOW_SAMPLES,
  timeToFrame,
} from './constants';
import { extractNotes, type NoteExtractionOptions } from './noteExtraction';
import type { WorkerRequest, WorkerResponse } from './workerProtocol';
import { dequantize } from './posteriors';
import { WEBGL_MEMORY_FLAGS, batchFor, chooseBackendOrder, isMemoryConstrained, type DeviceInfo } from './backendChoice';

// Stays single-threaded: on a cross-origin-isolated page the threaded build starts blob: scripts
// that the CSP does not allow.
tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
// Memory-safe WebGL (see backendChoice.ts): set before any WebGL kernel can run.
for (const [flag, value] of Object.entries(WEBGL_MEMORY_FLAGS)) {
  try {
    tf.env().set(flag, value);
  } catch (err) {
    console.warn(`[transcribe] could not set ${flag}`, err);
  }
}

setWasmPaths({
  'tfjs-backend-wasm.wasm': wasmPlain,
  'tfjs-backend-wasm-simd.wasm': wasmSimd,
  'tfjs-backend-wasm-threaded-simd.wasm': wasmThreaded,
});

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

let model: GraphModel | null = null;
let backendName = '';

function webglIsSoftware(): boolean {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  } catch {
    return true;
  }
}

async function initBackend(preferred?: string, device?: DeviceInfo): Promise<string> {
  const nav = (self as unknown as { navigator?: Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } } }).navigator;
  const offscreen = typeof OffscreenCanvas !== 'undefined';
  const facts = {
    ua: device?.ua ?? nav?.userAgent ?? '',
    maxTouchPoints: device?.maxTouchPoints,
    deviceMemory: device?.deviceMemory ?? nav?.deviceMemory,
    mobile: device?.mobile ?? nav?.userAgentData?.mobile,
  };
  // the renderer only matters where WebGL could lead (not on phones: no GPU context is made there);
  // a 1×1 WebGL2 context, released right after reading the renderer's name
  const softwareRenderer = !offscreen || isMemoryConstrained(facts) ? true : webglIsSoftware();
  const order = chooseBackendOrder({ ...facts, softwareRenderer, offscreen }, preferred);
  for (const name of order) {
    try {
      if (name === 'wasm') await import('@tensorflow/tfjs-backend-wasm');
      const ok = await tf.setBackend(name);
      if (ok) {
        await tf.ready();
        return name;
      }
    } catch (err) {
      console.warn(`[transcribe] backend ${name} unavailable`, err);
    }
  }
  throw new Error('No TensorFlow.js backend could be initialised in this browser.');
}

async function ensureModel(modelUrl: string, preferredBackend?: string, device?: DeviceInfo): Promise<void> {
  if (model) return;
  backendName = await initBackend(preferredBackend, device);
  try {
    model = await loadGraphModel(modelUrl);
    // warm-up + sanity check (some backends lack an op the graph needs)
    const probe = tf.zeros([1, BP_WINDOW_SAMPLES, 1]);
    const out = model.execute(probe, ['Identity_1']) as tf.Tensor;
    const values = await out.data();
    tf.dispose([probe, out]);
    if (!values.every(Number.isFinite)) throw new Error('backend produced invalid output');
  } catch (err) {
    if (backendName !== 'cpu') {
      console.warn(`[transcribe] ${backendName} failed, falling back to cpu`, err);
      model = null;
      await tf.setBackend('cpu');
      backendName = 'cpu';
      model = await loadGraphModel(modelUrl);
    } else {
      throw err;
    }
  }
}

/** RMS loudness envelope at 100 fps (used for note velocities). */
function rmsEnvelope(audio: Float32Array): Float32Array {
  const hop = BP_SAMPLE_RATE / 100;
  const n = Math.ceil(audio.length / hop);
  const out = new Float32Array(n);
  const half = 512;
  for (let i = 0; i < n; i++) {
    const c = Math.round(i * hop);
    let s = 0;
    let cnt = 0;
    for (let j = Math.max(0, c - half); j < Math.min(audio.length, c + half); j += 2) {
      s += audio[j] * audio[j];
      cnt++;
    }
    out[i] = cnt ? Math.sqrt(s / cnt) : 0;
  }
  return out;
}

async function runModel(audio: Float32Array, jobId: number) {
  const m = model!;
  const padHead = BP_OVERLAP_SAMPLES / 2;
  const paddedLen = padHead + audio.length;
  const numWindows = Math.max(1, Math.ceil(paddedLen / BP_HOP_SAMPLES));
  const nFrames = Math.min(numWindows * BP_KEPT_FRAMES, timeToFrame(audio.length / BP_SAMPLE_RATE) + 1);
  const frames = new Float32Array(nFrames * BP_N_PITCHES);
  const onsets = new Float32Array(nFrames * BP_N_PITCHES);
  const batch = batchFor(backendName);

  for (let w0 = 0; w0 < numWindows; w0 += batch) {
    if (cancelled.has(jobId)) throw new Error('cancelled');
    const b = Math.min(batch, numWindows - w0);
    const input = new Float32Array(b * BP_WINDOW_SAMPLES);
    for (let k = 0; k < b; k++) {
      const startPadded = (w0 + k) * BP_HOP_SAMPLES;
      for (let s = 0; s < BP_WINDOW_SAMPLES; s++) {
        const src = startPadded + s - padHead;
        if (src >= 0 && src < audio.length) input[k * BP_WINDOW_SAMPLES + s] = audio[src];
      }
    }
    const x = tf.tensor3d(input, [b, BP_WINDOW_SAMPLES, 1]);
    const [fr, on] = m.execute(x, ['Identity_1', 'Identity_2']) as tf.Tensor3D[];
    const frKept = tf.slice(fr, [0, BP_OVERLAP_HALF, 0], [b, BP_KEPT_FRAMES, BP_N_PITCHES]);
    const onKept = tf.slice(on, [0, BP_OVERLAP_HALF, 0], [b, BP_KEPT_FRAMES, BP_N_PITCHES]);
    const [frData, onData] = await Promise.all([frKept.data() as Promise<Float32Array>, onKept.data() as Promise<Float32Array>]);
    tf.dispose([x, fr, on, frKept, onKept]);
    const offset = w0 * BP_KEPT_FRAMES * BP_N_PITCHES;
    const len = Math.min(frData.length, frames.length - offset);
    if (len > 0) {
      frames.set(frData.subarray(0, len), offset);
      onsets.set(onData.subarray(0, len), offset);
    }
    post({ type: 'progress', jobId, stage: 'analyzing', progress: Math.min(1, (w0 + b) / numWindows) });
  }
  return { frames, onsets, nFrames };
}

function quantize(a: Float32Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(a[i] * 255)));
  return out;
}


const cancelled = new Set<number>();

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId);
    return;
  }
  const jobId = msg.jobId;
  try {
    if (msg.type === 'transcribe') {
      const t0 = performance.now();
      post({ type: 'progress', jobId, stage: 'loading-model', progress: 0 });
      await ensureModel(msg.modelUrl, msg.preferredBackend, msg.device);
      post({ type: 'progress', jobId, stage: 'loading-model', progress: 1, backend: backendName });
      const { frames, onsets, nFrames } = await runModel(msg.audio, jobId);
      post({ type: 'progress', jobId, stage: 'extracting', progress: 0 });
      const notes = extractNotes(frames, onsets, nFrames, msg.options);
      const leadNotes = msg.leadOptions ? extractNotes(frames, onsets, nFrames, msg.leadOptions) : undefined;
      const rms = rmsEnvelope(msg.audio);
      const fq = quantize(frames);
      const oq = quantize(onsets);
      post(
        {
          type: 'transcribed',
          jobId,
          notes,
          ...(leadNotes ? { leadNotes } : {}),
          nFrames,
          frames: fq,
          onsets: oq,
          rms,
          backend: backendName,
          ms: performance.now() - t0,
        },
        [fq.buffer, oq.buffer, rms.buffer],
      );
    } else if (msg.type === 'extract') {
      const frames = dequantize(msg.frames);
      const onsets = dequantize(msg.onsets);
      const notes = extractNotes(frames, onsets, msg.nFrames, msg.options as NoteExtractionOptions);
      const leadNotes = msg.leadOptions ? extractNotes(frames, onsets, msg.nFrames, msg.leadOptions) : undefined;
      post({ type: 'extracted', jobId, notes, ...(leadNotes ? { leadNotes } : {}) });
    }
  } catch (err) {
    post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
  } finally {
    cancelled.delete(jobId);
  }
};
