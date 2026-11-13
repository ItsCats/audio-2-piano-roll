// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * homr's three networks on onnxruntime-web: segmentation, the transformer's encoder, and its decoder
 * stepped greedily with the KV cache the ONNX export already has (homr/transformer/decoder_inference.py).
 * The onnxruntime module is passed in, so the worker (onnxruntime-web/wasm) and the Node parity
 * check (onnxruntime-web's Node build) share this code.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import type * as OrtNs from 'onnxruntime-web';
import type { HomrInfer, TokenIds } from './pipeline';

type Ort = typeof OrtNs;
type Session = OrtNs.InferenceSession;
type Tensor = OrtNs.Tensor;

export interface HomrSessions {
  segnet: Session;
  encoder: Session;
  decoder: Session;
}

const DEPTH = 8;
const HEADS = 8;
const HEAD_DIM = 64;
const CACHES = DEPTH * 4;
const OUTS = ['out_rhythms', 'out_pitchs', 'out_lifts', 'out_articulations', 'out_slurs', 'out_positions'] as const;

function argmax(a: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
  return best;
}

/** Statistics of the network runs (milliseconds, steps). */
export interface InferStats {
  segmentMs: number;
  encodeMs: number;
  decodeMs: number;
  steps: number;
  windows: number;
  staffs: number;
}

export type SessionName = keyof HomrSessions;

/**
 * Low-memory variant (phones): only the networks of the current step exist. Segmentation runs with the
 * segmentation session alone; before the first staff is read it is released and the encoder and
 * decoder are created (and the other way round on the next page), so the WASM heap's high-water mark
 * is the larger of the two steps instead of their sum (freed WASM memory is reused, never returned).
 * Costs one session creation per step and page (a few seconds against minutes of reading on a phone).
 */
export function stagedInfer(ort: Ort, create: (name: SessionName) => Promise<Session>, stats?: InferStats): HomrInfer & { release(): Promise<void> } {
  const open: Partial<HomrSessions> = {};
  const drop = async (...names: SessionName[]) => {
    for (const n of names) {
      const sn = open[n];
      delete open[n];
      await sn?.release().catch(() => undefined);
    }
  };
  const ensure = async (...names: SessionName[]) => {
    for (const n of names) open[n] ??= await create(n);
  };
  const view = (): HomrSessions => open as HomrSessions;
  return {
    async segment(windows, n) {
      await drop('encoder', 'decoder');
      await ensure('segnet');
      return ortInfer(ort, view(), stats).segment(windows, n);
    },
    async transcribe(input, maxSteps, eos) {
      await drop('segnet');
      await ensure('encoder', 'decoder');
      return ortInfer(ort, view(), stats).transcribe(input, maxSteps, eos);
    },
    release: () => drop('segnet', 'encoder', 'decoder'),
  };
}

export function ortInfer(ort: Ort, s: HomrSessions, stats?: InferStats): HomrInfer {
  return {
    async segment(windows: Float32Array, n: number): Promise<Float32Array> {
      const t0 = performance.now();
      const input = new ort.Tensor('float32', windows, [n, 3, 320, 320]);
      const out = await s.segnet.run({ [s.segnet.inputNames[0]]: input });
      const t = out[s.segnet.outputNames[0]];
      const data = (t.data as Float32Array).slice();
      t.dispose();
      input.dispose();
      if (stats) {
        stats.segmentMs += performance.now() - t0;
        stats.windows += n;
      }
      return data;
    },

    async transcribe(inputData: Float32Array, maxSteps: number, eos: number): Promise<TokenIds[]> {
      const t0 = performance.now();
      const input = new ort.Tensor('float32', inputData, [1, 1, 256, 1280]);
      const enc = await s.encoder.run({ [s.encoder.inputNames[0]]: input });
      input.dispose();
      const context = enc[s.encoder.outputNames[0]];
      const t1 = performance.now();
      const [, ctxLen, dim] = context.dims;
      // after the first step the decoder only gets the first context vector (homr: context[:, :1])
      const reduced = new ort.Tensor('float32', (context.data as Float32Array).slice(0, dim), [1, 1, dim]);
      let cache: Tensor[] = [];
      for (let i = 0; i < CACHES; i++) cache.push(new ort.Tensor('float32', new Float32Array(0), [1, HEADS, 0, HEAD_DIM]));
      const tok = (v: number) => new ort.Tensor('int64', BigInt64Array.from([BigInt(v)]), [1, 1]);
      let last: [number, number, number, number, number] = [1, 0, 0, 0, 0]; // rhythm (BOS), pitch, lift, articulation, slur
      const out: TokenIds[] = [];
      try {
        for (let step = 0; step < maxSteps; step++) {
          const feeds: Record<string, Tensor> = {
            rhythms: tok(last[0]),
            pitchs: tok(last[1]),
            lifts: tok(last[2]),
            articulations: tok(last[3]),
            slurs: tok(last[4]),
            context: step === 0 ? context : reduced,
            cache_len: new ort.Tensor('int64', BigInt64Array.from([BigInt(step)]), [1]),
          };
          cache.forEach((c, i) => (feeds[`cache_in${i}`] = c));
          const res = await s.decoder.run(feeds);
          for (const k of ['rhythms', 'pitchs', 'lifts', 'articulations', 'slurs', 'cache_len']) feeds[k].dispose();
          for (const c of cache) c.dispose();
          cache = Array.from({ length: CACHES }, (_, i) => res[`cache_out${i}`]);
          const ids = OUTS.map((name) => {
            const t = res[name];
            const id = argmax(t.data as Float32Array);
            t.dispose();
            return id;
          });
          res.attention?.dispose();
          const [r, p, l, a, sl, pos] = ids;
          if (r === eos) break;
          out.push([r, p, l, a, sl, pos]);
          last = [r, p, l, a, sl];
        }
      } finally {
        for (const c of cache) c.dispose();
        context.dispose();
        reduced.dispose();
      }
      if (stats) {
        stats.encodeMs += t1 - t0;
        stats.decodeMs += performance.now() - t1;
        stats.steps += out.length;
        stats.staffs++;
      }
      void ctxLen;
      return out;
    },
  };
}
