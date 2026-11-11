import { describe, expect, it } from 'vitest';
import {
  BINS,
  FRAMES,
  N_FFT,
  RealFFT,
  SEGMENT,
  SegmentStft,
  DRUM_ENV_FPS,
  decimate2,
  drumOnsetEnvelope,
  halfbandTaps,
  mixStats,
  planSegments,
  segmentWeight,
  separateSegments,
  stemPlanes,
  vocalPresence,
} from '../../src/lib/separation/dsp';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}
function noise(n: number, seed: number, amp = 0.3) {
  const r = rng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * r() + 0.2 * Math.sin(i * 0.013 + seed);
  return x;
}
const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>, lo = 0, hi = a.length) => {
  let m = 0;
  for (let i = lo; i < hi; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe('RealFFT', () => {
  it('matches a direct DFT and inverts exactly', () => {
    const n = 64;
    const fft = new RealFFT(n);
    const x = Float64Array.from(noise(n, 1));
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    fft.forward(x, re, im);
    for (let k = 0; k <= n / 2; k++) {
      let r = 0;
      let i = 0;
      for (let t = 0; t < n; t++) {
        r += x[t] * Math.cos((2 * Math.PI * k * t) / n);
        i -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(r, 10);
      expect(im[k]).toBeCloseTo(i, 10);
    }
    const y = new Float64Array(n);
    fft.inverse(re, im, y);
    expect(maxAbsDiff(x, y)).toBeLessThan(1e-12);
  });
});

describe('SegmentStft', () => {
  it('round-trips one 11 s segment (STFT → iSTFT) to float precision', () => {
    const stft = new SegmentStft();
    const seg = Float64Array.from(noise(SEGMENT, 2));
    const plane = BINS * FRAMES;
    const spec = new Float32Array(2 * plane);
    stft.forward(seg, spec.subarray(0, plane), spec.subarray(plane));
    const y = new Float64Array(SEGMENT);
    stft.inverseSum(spec, [[0, plane]], 1, y);
    // spectra are stored as float32 (the model's input type)
    expect(maxAbsDiff(seg, y)).toBeLessThan(1e-5);
  });

  it('uses the model layout: DC bin of frame m is the frame sum / sqrt(n_fft)', () => {
    const stft = new SegmentStft();
    const seg = new Float64Array(SEGMENT).fill(0.5);
    const plane = BINS * FRAMES;
    const spec = new Float32Array(2 * plane);
    stft.forward(seg, spec.subarray(0, plane), spec.subarray(plane));
    // interior frame, bin 0 at [0 * FRAMES + m]
    expect(spec[100]).toBeCloseTo((0.5 * N_FFT) / Math.sqrt(N_FFT), 3);
    expect(Math.abs(spec[FRAMES + 100])).toBeLessThan(1e-4); // bin 1 of a constant
  });
});

describe('segment plan and cross-fades', () => {
  it('covers every input sample with weights that sum to > 0', () => {
    for (const n of [1000, 90000, SEGMENT - 7, SEGMENT + 1, 3 * SEGMENT + 12345]) {
      const plan = planSegments(n);
      const ws = new Float64Array(plan.m);
      plan.starts.forEach((st, k) => {
        const len = Math.min(SEGMENT, plan.m - st);
        for (let i = 0; i < len; i++) ws[st + i] += segmentWeight(i, k, plan.starts.length, plan.fadeN);
      });
      let min = Infinity;
      for (let i = plan.offset; i < plan.offset + n; i++) min = Math.min(min, ws[i]);
      expect(min).toBeGreaterThan(0);
      expect(plan.starts[plan.starts.length - 1] + SEGMENT).toBeGreaterThanOrEqual(plan.m);
    }
  });

  it('segments every 9.9 s (step 0.9, 1.1 s fades)', () => {
    const plan = planSegments(60 * 44100);
    expect(plan.fadeN).toBe(48510);
    expect(plan.starts[1] - plan.starts[0]).toBe(Math.floor(SEGMENT * 0.9));
    expect(plan.starts.length).toBe(7);
  });
});

describe('separateSegments', () => {
  /** identity "model": stem 0 (drums) gets the input spectrum, everything else 0 */
  const identity = async (spec: Float32Array) => {
    const plane = BINS * FRAMES;
    const out = new Float32Array(16 * plane);
    out.set(spec.subarray(0, 4 * plane), 0); // drums L re, L im, R re, R im
    return { data: out };
  };

  for (const n of [44100 * 2, 44100 * 8, 44100 * 30 + 17]) {
    it(`reconstructs a ${(n / 44100).toFixed(1)} s mixture through an identity model (minus DC)`, async () => {
      const left = noise(n, 3);
      const right = noise(n, 4);
      let calls = 0;
      const res = await separateSegments(left, right, [{ name: 'all', stems: [0] }, { name: 'none', stems: [3] }], identity, {
        onSegment: () => calls++,
      });
      const { mean } = mixStats(left, right);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) / 2 - mean;
      expect(calls).toBe(planSegments(n).starts.length);
      expect(maxAbsDiff(res.all, mono)).toBeLessThan(2e-5);
      expect(maxAbsDiff(res.none, new Float32Array(n))).toBe(0);
    });
  }

  it('sums stems: groups [1,2] = bass + other', async () => {
    const n = 44100 * 3;
    const left = noise(n, 5);
    const right = noise(n, 6);
    const plane = BINS * FRAMES;
    // bass gets 0.25 x input, other 0.75 x input
    const model = async (spec: Float32Array) => {
      const out = new Float32Array(16 * plane);
      for (let i = 0; i < 4 * plane; i++) {
        out[4 * plane + i] = 0.25 * spec[i];
        out[8 * plane + i] = 0.75 * spec[i];
      }
      return { data: out };
    };
    const res = await separateSegments(left, right, [{ name: 'accomp', stems: [1, 2] }], model);
    const { mean } = mixStats(left, right);
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(res.accomp[i] - ((left[i] + right[i]) / 2 - mean)));
    expect(m).toBeLessThan(2e-5);
    expect(stemPlanes([3])[0][0]).toBe(12 * plane);
  });

  for (const [secs, step] of [
    [2, undefined],
    [30.4, undefined],
    [25, 0.5],
  ] as const) {
    it(`half rate equals decimating the full-rate result (${secs} s${step ? `, step ${step}` : ''})`, async () => {
      const n = Math.round(44100 * secs) + 1;
      const left = noise(n, 11);
      const right = noise(n, 12);
      const groups = [{ name: 'all', stems: [0] }];
      const full = await separateSegments(left, right, groups, identity, { step });
      const half = await separateSegments(left, right, groups, identity, { step, half: true });
      const ref = decimate2(full.all);
      expect(half.all.length).toBe(Math.floor(n / 2));
      expect(maxAbsDiff(half.all, ref)).toBeLessThan(2e-6);
    });
  }

  it('overlapping segments (step 0.5) still reconstruct the mixture (weights from the plan)', async () => {
    const n = 44100 * 25;
    const left = noise(n, 13);
    const right = noise(n, 14);
    const res = await separateSegments(left, right, [{ name: 'all', stems: [0] }], identity, { step: 0.5 });
    const { mean } = mixStats(left, right);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (left[i] + right[i]) / 2 - mean;
    expect(maxAbsDiff(res.all, mono)).toBeLessThan(2e-5);
  });

  it('stops when asked', async () => {
    const n = 44100 * 30;
    let k = 0;
    await expect(
      separateSegments(noise(n, 1), noise(n, 2), [{ name: 'a', stems: [0] }], identity, { onSegment: () => k++, shouldStop: () => k >= 1 }),
    ).rejects.toThrow(/cancelled/);
    expect(k).toBe(1);
  });
});

describe('decimate2', () => {
  it('has unity DC gain, zero phase and the floor(n/2) length of the browser decoder', () => {
    const h = halfbandTaps();
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const n = 44101;
    const x = new Float32Array(n);
    // 1 kHz tone at 44.1 kHz → same tone at 22.05 kHz, sample-aligned (out[j] ≈ x[2j])
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100);
    const y = decimate2(x);
    expect(y.length).toBe(22050);
    let m = 0;
    for (let j = 100; j < y.length - 100; j++) m = Math.max(m, Math.abs(y[j] - x[2 * j]));
    expect(m).toBeLessThan(1e-3);
  });

  it('removes content above the output Nyquist', () => {
    const n = 44100;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 15000 * i) / 44100);
    const y = decimate2(x);
    let e = 0;
    for (let j = 200; j < y.length - 200; j++) e += y[j] * y[j];
    expect(10 * Math.log10(e / (y.length - 400) / 0.5)).toBeLessThan(-70);
  });
});

describe('vocalPresence', () => {
  const sr = 22050;
  it('is false when the vocal stem is ~55 dB under the mix, true when singing', () => {
    const n = sr * 20;
    const mix = noise(n, 7, 0.5);
    const quiet = Float32Array.from(mix, (v) => v * 10 ** (-55 / 20));
    const off = vocalPresence(quiet, mix, sr);
    expect(off.present).toBe(false);
    expect(off.activeFraction).toBe(0);
    expect(off.relDb).toBeCloseTo(-55, 1);
    // singing in 30% of the song at -6 dB
    const voc = new Float32Array(n);
    for (let i = 0; i < n * 0.3; i++) voc[i] = mix[i] * 0.5;
    const on = vocalPresence(voc, mix, sr);
    expect(on.present).toBe(true);
    expect(on.activeFraction).toBeCloseTo(0.3, 1);
  });

  it('ignores silent passages of the mix', () => {
    const n = sr * 10;
    const mix = noise(n, 8, 0.5);
    mix.fill(0, n / 2);
    const voc = Float32Array.from(mix, (v) => v * 0.5);
    expect(vocalPresence(voc, mix, sr).activeFraction).toBeCloseTo(1, 5);
  });
});

describe('drumOnsetEnvelope', () => {
  const rate = 44100;
  /** decaying noise bursts (kick-like: low-passed) at the given times, over a quiet sine bed */
  function drumTrack(seconds: number, hits: number[], amp = 0.8) {
    const n = Math.round(seconds * rate);
    const x = new Float32Array(n);
    const r = rng(5);
    for (const t of hits) {
      const s = Math.round(t * rate);
      let lp = 0;
      for (let i = 0; i < 0.15 * rate && s + i < n; i++) {
        lp += 0.05 * (r() - lp);
        x[s + i] += amp * Math.exp(-i / (0.03 * rate)) * (lp * 8 + 0.5 * Math.sin((2 * Math.PI * 60 * i) / rate));
      }
    }
    return x;
  }
  const bed = (n: number, amp = 0.2) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));
  const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
  const peaks = (env: Uint8Array, min: number) => {
    const out: number[] = [];
    for (let i = 1; i < env.length - 1; i++) if (env[i] >= min && env[i] >= env[i - 1] && env[i] > env[i + 1]) out.push(i);
    return out;
  };

  it('is silent without drums and has one frame per 10 ms', () => {
    const mix = bed(rate * 2);
    const env = drumOnsetEnvelope(new Float32Array(mix.length), mix, rate);
    expect(env.length).toBe(Math.floor(mix.length / (rate / DRUM_ENV_FPS)) + 1);
    expect(Math.max(...env)).toBe(0);
  });

  it('peaks at the hits, within one frame', () => {
    const hits = [0.3, 0.8, 1.25, 1.9];
    const drums = drumTrack(2.5, hits);
    const env = drumOnsetEnvelope(drums, add(drums, bed(drums.length)), rate);
    const p = peaks(env, 30);
    expect(p.length).toBe(hits.length);
    p.forEach((f, i) => expect(Math.abs(f - hits[i] * DRUM_ENV_FPS)).toBeLessThanOrEqual(1));
  });

  it('is measured relative to the mixture level (gain invariant) and stays low for leakage', () => {
    const drums = drumTrack(2, [0.5, 1.2]);
    const mix = add(drums, bed(drums.length));
    const env = drumOnsetEnvelope(drums, mix, rate);
    const quiet = drumOnsetEnvelope(drums.map((v) => v * 0.25), mix.map((v) => v * 0.25), rate);
    for (let i = 0; i < env.length; i++) expect(Math.abs(env[i] - quiet[i])).toBeLessThanOrEqual(1);
    // a drum stem 40 dB under the mixture (separation leakage of a song without drums)
    const leak = drumOnsetEnvelope(drums.map((v) => v * 0.01), mix, rate);
    expect(Math.max(...leak)).toBeLessThan(Math.max(...env) / 3);
  });
});

describe('separationSupport and recording length', () => {
  it('does not recommend separating long recordings in the browser (memory grows with length)', async () => {
    const { vi } = await import('vitest');
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('navigator', { userAgent: 'Desktop', deviceMemory: 4, hardwareConcurrency: 4, maxTouchPoints: 0 });
    try {
      const { separationSupport, estimateSeparationMB, BROWSER_SEPARATION_MAX_SECONDS } = await import('../../src/lib/separation');
      expect(separationSupport(240).recommended).toBe(true);
      const long = separationSupport(15 * 60);
      expect(long.ok).toBe(true);
      expect(long.recommended).toBe(false);
      expect(long.maxSeconds).toBe(BROWSER_SEPARATION_MAX_SECONDS);
      expect(long.reason).toMatch(/15-minute recording needs about 3\.\d GB/);
      expect(estimateSeparationMB(20 * 60)).toBeGreaterThan(estimateSeparationMB(4 * 60));
      // 8 GB devices may separate up to the 20-minute import limit
      vi.stubGlobal('navigator', { userAgent: 'Desktop', deviceMemory: 8, hardwareConcurrency: 4, maxTouchPoints: 0 });
      expect(separationSupport(15 * 60).recommended).toBe(true);
      expect(separationSupport().maxSeconds).toBe(20 * 60);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
