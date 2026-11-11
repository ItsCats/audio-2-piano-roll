/**
 * Signal processing for in-browser SCNet source separation. Pure functions (no DOM, no ONNX) so
 * they run in the worker and in unit tests.
 *
 * The SCNet ONNX export (audiojs, int8 weights) contains only the network between STFT and iSTFT:
 *   mix_spec   [1, 4, 2049, 476]  (L re, L im, R re, R im)  — 11 s of 44.1 kHz stereo
 *   stems_spec [1, 16, 2049, 476] (stem s, channel c: re at 2*(2s+c), im at 2*(2s+c)+1)
 *   stems: 0 drums, 1 bass, 2 other, 3 vocals
 * The STFT/iSTFT (n_fft 4096, hop 1024, rectangular window, centred reflect padding, 1/sqrt(n_fft)
 * normalisation) and the segmenting (Music-Source-Separation-Training demix(): 11 s segments,
 * linear cross-fades, sum / sum-of-weights) run here in Float64. Mirrors the python reference
 * (onnxruntime + numpy) to > 50 dB.
 */

export const SCNET_RATE = 44100;
export const N_FFT = 4096;
export const HOP = 1024;
export const FRAMES = 476;
export const BINS = N_FFT / 2 + 1;
/** samples per model segment (11 s) */
export const SEGMENT = 485100;
/** default hop between segments as a fraction of SEGMENT (0.9 → 10% overlap) */
export const DEFAULT_STEP = 0.9;
/** cross-fade length as a fraction of SEGMENT (1.1 s) */
export const DEFAULT_FADE = 0.1;

const SCALE = 1 / Math.sqrt(N_FFT);
const PADDED = (FRAMES - 1) * HOP; // 486400 >= SEGMENT

/** Mirror an index into [0, n) without repeating the edge sample (numpy 'reflect'). Valid for -n < i < 2n - 1. */
export function reflectIndex(i: number, n: number): number {
  if (i < 0) i = -i;
  return i >= n ? 2 * (n - 1) - i : i;
}

/** Real FFT of size n via a complex FFT of size n/2 (packing trick), Float64. */
export class RealFFT {
  readonly n: number;
  private readonly h: number;
  private readonly rev: Uint32Array;
  private readonly cosH: Float64Array;
  private readonly sinH: Float64Array;
  private readonly cosN: Float64Array;
  private readonly sinN: Float64Array;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;

  constructor(n: number) {
    if (n < 4 || n & (n - 1)) throw new Error('FFT size must be a power of two >= 4');
    this.n = n;
    const h = (this.h = n >> 1);
    this.rev = new Uint32Array(h);
    const bits = Math.log2(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cosH = new Float64Array(h / 2);
    this.sinH = new Float64Array(h / 2);
    for (let k = 0; k < h / 2; k++) {
      this.cosH[k] = Math.cos((2 * Math.PI * k) / h);
      this.sinH[k] = -Math.sin((2 * Math.PI * k) / h);
    }
    this.cosN = new Float64Array(h + 1);
    this.sinN = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      this.cosN[k] = Math.cos((2 * Math.PI * k) / n);
      this.sinN[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    this.zr = new Float64Array(h);
    this.zi = new Float64Array(h);
  }

  /** in-place complex FFT of size n/2; inverse uses conjugate twiddles (unscaled) */
  private cfft(re: Float64Array, im: Float64Array, inverse: boolean) {
    const h = this.h;
    const rev = this.rev;
    for (let i = 0; i < h; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const cs = this.cosH;
    const sn = this.sinH;
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= h; size <<= 1) {
      const half = size >> 1;
      const step = h / size;
      for (let start = 0; start < h; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cs[t];
          const wi = sgn * sn[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /** x: n real samples → X[0..n/2] (unnormalised, like numpy.fft.rfft) */
  forward(x: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const h = this.h;
    const zr = this.zr;
    const zi = this.zi;
    for (let i = 0; i < h; i++) {
      zr[i] = x[2 * i];
      zi[i] = x[2 * i + 1];
    }
    this.cfft(zr, zi, false);
    for (let k = 0; k < h; k++) {
      const m = k === 0 ? 0 : h - k;
      const er = 0.5 * (zr[k] + zr[m]);
      const ei = 0.5 * (zi[k] - zi[m]);
      const or = 0.5 * (zi[k] + zi[m]);
      const oi = -0.5 * (zr[k] - zr[m]);
      const wr = this.cosN[k];
      const wi = this.sinN[k];
      outRe[k] = er + wr * or - wi * oi;
      outIm[k] = ei + wr * oi + wi * or;
      if (k === 0) {
        outRe[h] = er - or;
        outIm[h] = ei - oi;
      }
    }
  }

  /** X[0..n/2] → n real samples, scaled by 1/n (like numpy.fft.irfft) */
  inverse(inRe: Float64Array, inIm: Float64Array, out: Float64Array): void {
    const h = this.h;
    const zr = this.zr;
    const zi = this.zi;
    for (let k = 0; k < h; k++) {
      const ar = inRe[k];
      const ai = inIm[k];
      const br = inRe[h - k];
      const bi = -inIm[h - k];
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br);
      const di = 0.5 * (ai - bi);
      const wr = this.cosN[k];
      const wi = -this.sinN[k];
      const or = dr * wr - di * wi;
      const oi = dr * wi + di * wr;
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this.cfft(zr, zi, true);
    const s = 1 / h;
    for (let i = 0; i < h; i++) {
      out[2 * i] = zr[i] * s;
      out[2 * i + 1] = zi[i] * s;
    }
  }
}

/**
 * STFT / iSTFT of exactly one SCNet segment (SEGMENT samples ↔ BINS × FRAMES), with reusable
 * scratch buffers. Spectra are laid out like the model tensors: plane = BINS * FRAMES floats,
 * element [f, t] at f * FRAMES + t.
 */
export class SegmentStft {
  private readonly fft = new RealFFT(N_FFT);
  private readonly xpad = new Float64Array(PADDED);
  private readonly frame = new Float64Array(N_FFT);
  private readonly fRe = new Float64Array(BINS);
  private readonly fIm = new Float64Array(BINS);
  private readonly ola = new Float64Array((FRAMES - 1) * HOP + N_FFT);
  private static env: Float64Array | null = null;

  /** number of frames covering each output sample (rectangular window) */
  private static envelope(): Float64Array {
    if (!SegmentStft.env) {
      const e = new Float64Array((FRAMES - 1) * HOP + N_FFT);
      for (let m = 0; m < FRAMES; m++) for (let i = 0; i < N_FFT; i++) e[m * HOP + i] += 1;
      SegmentStft.env = e;
    }
    return SegmentStft.env;
  }

  /** STFT of `seg` (SEGMENT samples) into re/im planes (each BINS*FRAMES floats). */
  forward(seg: Float64Array, re: Float32Array, im: Float32Array): void {
    const { xpad, frame, fRe, fIm, fft } = this;
    xpad.fill(0);
    xpad.set(seg.subarray(0, SEGMENT));
    const T = FRAMES;
    for (let m = 0; m < T; m++) {
      const pos = m * HOP - N_FFT / 2;
      if (pos < 0 || pos + N_FFT > PADDED) for (let i = 0; i < N_FFT; i++) frame[i] = xpad[reflectIndex(pos + i, PADDED)];
      else for (let i = 0; i < N_FFT; i++) frame[i] = xpad[pos + i];
      fft.forward(frame, fRe, fIm);
      for (let f = 0; f < BINS; f++) {
        re[f * T + m] = fRe[f] * SCALE;
        im[f * T + m] = fIm[f] * SCALE;
      }
    }
  }

  /**
   * iSTFT of the SUM of several spectra (the transform is linear, so summing stems and channels
   * before the inverse is exact), times `gain`, into out[0..SEGMENT).
   * `planes` lists [reOffset, imOffset] pairs into `z`.
   */
  inverseSum(z: Float32Array, planes: ReadonlyArray<readonly [number, number]>, gain: number, out: Float64Array): void {
    const { ola, frame, fRe, fIm, fft } = this;
    const env = SegmentStft.envelope();
    ola.fill(0);
    const T = FRAMES;
    const g = 1 / SCALE;
    for (let m = 0; m < T; m++) {
      for (let f = 0; f < BINS; f++) {
        let r = 0;
        let i = 0;
        const idx = f * T + m;
        for (let p = 0; p < planes.length; p++) {
          r += z[planes[p][0] + idx];
          i += z[planes[p][1] + idx];
        }
        fRe[f] = r * g;
        fIm[f] = i * g;
      }
      fft.inverse(fRe, fIm, frame);
      const off = m * HOP;
      for (let i = 0; i < N_FFT; i++) ola[off + i] += frame[i];
    }
    const p = N_FFT / 2;
    for (let i = 0; i < SEGMENT; i++) out[i] = (ola[p + i] / env[p + i]) * gain;
  }
}

/** Offsets of the re/im planes of (stem, channel) in the model output. */
export function stemPlanes(stems: readonly number[], channels: readonly number[] = [0, 1]): Array<readonly [number, number]> {
  const plane = BINS * FRAMES;
  const out: Array<readonly [number, number]> = [];
  for (const s of stems) for (const c of channels) out.push([2 * (s * 2 + c) * plane, (2 * (s * 2 + c) + 1) * plane]);
  return out;
}

export interface SegmentPlan {
  /** samples of the input */
  n: number;
  /** length of the (possibly reflect-extended) working signal */
  m: number;
  /** offset of the input inside the working signal */
  offset: number;
  starts: number[];
  fadeN: number;
}

/** Segment layout of demix(): extend by `border` on each side when long enough, segments every step*SEGMENT. */
export function planSegments(n: number, step = DEFAULT_STEP, fade = DEFAULT_FADE, segment = SEGMENT): SegmentPlan {
  const stepN = Math.floor(segment * step);
  const border = segment - stepN;
  const wide = n > 2 * border;
  const m = wide ? n + 2 * border : n;
  const starts: number[] = [];
  for (let s = 0; ; s += stepN) {
    starts.push(s);
    if (s + segment >= m) break;
  }
  return { n, m, offset: wide ? border : 0, starts, fadeN: Math.floor(segment * fade) };
}

/** Linear cross-fade weight of sample i of segment k (fade-in except for the first, fade-out except for the last). */
export function segmentWeight(i: number, k: number, count: number, fadeN: number, segment = SEGMENT): number {
  let a = 1;
  if (k > 0 && i < fadeN) a = i / (fadeN - 1);
  if (k < count - 1 && i >= segment - fadeN) a = Math.min(a, (segment - 1 - i) / (fadeN - 1));
  return a;
}

export interface MixStats {
  mean: number;
  std: number;
}

/** mean and (ddof=1) standard deviation of the mono downmix, used to normalise the model input */
export function mixStats(left: Float32Array, right: Float32Array): MixStats {
  const n = left.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += (left[i] + right[i]) * 0.5;
  mean /= Math.max(1, n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = (left[i] + right[i]) * 0.5 - mean;
    v += d * d;
  }
  return { mean, std: Math.sqrt(v / Math.max(1, n - 1)) + 1e-8 };
}

/**
 * Fill seg (SEGMENT samples) with segment `start` of the normalised, reflect-extended channel.
 * Mirrors demix(): a short final segment is reflect-padded when longer than half a segment, else zero-padded.
 */
export function fillSegment(ch: Float32Array, plan: SegmentPlan, start: number, stats: MixStats, seg: Float64Array): number {
  const { n, m, offset } = plan;
  const len = Math.min(SEGMENT, m - start);
  const reflect = len > SEGMENT / 2;
  const inv = 1 / stats.std;
  for (let i = 0; i < SEGMENT; i++) {
    let j: number;
    if (i < len) j = start + i;
    else if (reflect) j = start + reflectIndex(i, len);
    else {
      seg[i] = 0;
      continue;
    }
    const src = offset ? reflectIndex(j - offset, n) : j;
    seg[i] = (ch[src] - stats.mean) * inv;
  }
  return len;
}

export interface StemGroup {
  name: string;
  stems: number[];
}

export interface SegmentRunner {
  /** spec: Float32Array(4*BINS*FRAMES) → model output Float32Array(16*BINS*FRAMES). `release` frees the output. */
  (spec: Float32Array): Promise<{ data: Float32Array; release?: () => void }>;
}

/**
 * Run segmented separation of a stereo signal and return each group as a MONO (L+R)/2 signal,
 * de-normalised (the stems sum to the mixture minus its DC offset).
 *
 * With `half` the groups come back at HALF the input rate (decimate2's filter and timebase,
 * length floor(n/2)): each segment's cross-faded contribution is decimated before it is added,
 * which is exact because both the overlap-add and the FIR are linear. That keeps one
 * half-length accumulator per group instead of a full-rate one, so a long song needs far less
 * memory. The sum of the cross-fade weights is computed from the plan (it is 1 wherever the
 * default fades overlap) instead of being stored for every sample.
 */
export async function separateSegments(
  left: Float32Array,
  right: Float32Array,
  groups: StemGroup[],
  run: SegmentRunner,
  opts: { step?: number; fade?: number; half?: boolean; onSegment?: (done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<Record<string, Float32Array>> {
  const n = left.length;
  if (right.length !== n) throw new Error('channel length mismatch');
  const plan = planSegments(n, opts.step ?? DEFAULT_STEP, opts.fade ?? DEFAULT_FADE);
  const stats = mixStats(left, right);
  const stft = new SegmentStft();
  const plane = BINS * FRAMES;
  const segL = new Float64Array(SEGMENT);
  const segR = new Float64Array(SEGMENT);
  const y = new Float64Array(SEGMENT);
  const w = new Float64Array(SEGMENT);
  const half = !!opts.half;
  const outLen = half ? Math.floor(n / 2) : n;
  const acc: Record<string, Float32Array> = {};
  for (const g of groups) acc[g.name] = new Float32Array(outLen);
  const planes = groups.map((g) => stemPlanes(g.stems));
  const count = plan.starts.length;
  // the part of each segment that is kept (inside the original signal), in working-signal coordinates
  const keptLo: number[] = [];
  const keptHi: number[] = [];
  for (const st of plan.starts) {
    const len = Math.min(SEGMENT, plan.m - st);
    keptLo.push(st + Math.max(0, plan.offset - st));
    keptHi.push(st + Math.min(len, plan.offset + n - st));
  }
  // half rate: one segment's contribution with zero padding for the decimation filter
  const K = HALFBAND_K;
  // outputs whose filter reaches the kept range start K input samples before it and read up to K - 1 further
  const P = 2 * K + 2;
  const h = half ? halfbandTaps() : null;
  const cb = half ? new Float64Array(SEGMENT + 2 * P) : null;
  for (let k = 0; k < count; k++) {
    if (opts.shouldStop?.()) throw new DOMException('Separation cancelled', 'AbortError');
    const st = plan.starts[k];
    const len = fillSegment(left, plan, st, stats, segL);
    fillSegment(right, plan, st, stats, segR);
    let spec: Float32Array | null = new Float32Array(4 * plane);
    stft.forward(segL, spec.subarray(0, plane), spec.subarray(plane, 2 * plane));
    stft.forward(segR, spec.subarray(2 * plane, 3 * plane), spec.subarray(3 * plane, 4 * plane));
    const out = await run(spec);
    spec = null;
    // only the part of this segment inside the original signal is kept
    const lo = Math.max(0, plan.offset - st);
    const hi = Math.min(len, plan.offset + n - st);
    const base = st - plan.offset;
    // this segment's weight divided by the sum of the weights of every segment kept at that sample
    for (let i = lo; i < hi; i++) {
      const x = st + i;
      let sum = 0;
      for (let j = k; j >= 0 && plan.starts[j] + SEGMENT > x; j--) if (x >= keptLo[j] && x < keptHi[j]) sum += segmentWeight(x - plan.starts[j], j, count, plan.fadeN);
      for (let j = k + 1; j < count && plan.starts[j] <= x; j++) if (x >= keptLo[j] && x < keptHi[j]) sum += segmentWeight(x - plan.starts[j], j, count, plan.fadeN);
      w[i] = sum > 0 ? segmentWeight(i, k, count, plan.fadeN) / sum : 0;
    }
    for (let g = 0; g < groups.length; g++) {
      stft.inverseSum(out.data, planes[g], 0.5 * stats.std, y);
      const a = acc[groups[g].name];
      if (!half) {
        for (let i = lo; i < hi; i++) a[base + i] += y[i] * w[i];
        continue;
      }
      // decimate this segment's contribution (zero outside lo..hi) into the half-rate accumulator:
      // cb[P + i] holds input sample base + i
      cb!.fill(0);
      for (let i = lo; i < hi; i++) cb![P + i] = y[i] * w[i];
      const j0 = Math.max(0, Math.ceil((base + lo - K) / 2));
      const j1 = Math.min(outLen - 1, Math.floor((base + hi - 1 + K) / 2));
      for (let j = j0; j <= j1; j++) {
        const c = 2 * j - base + P;
        let s = h![K] * cb![c];
        for (let t = 1; t <= K; t += 2) s += h![K + t] * (cb![c - t] + cb![c + t]);
        a[j] += s;
      }
    }
    out.release?.();
    opts.onSegment?.(k + 1, count);
  }
  return acc;
}

// ---------------------------------------------------------------------------------------------
// 2:1 decimation 44.1 kHz → 22.05 kHz

const HALFBAND_K = 64; // taps each side (129-tap linear-phase half-band FIR)
let halfband: Float64Array | null = null;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Kaiser-windowed half-band low-pass (cutoff at the output Nyquist), unity DC gain. h[K + j] for j = -K..K. */
export function halfbandTaps(): Float64Array {
  if (halfband) return halfband;
  const K = HALFBAND_K;
  const beta = 8.6; // ≈ 85 dB side lobes
  const h = new Float64Array(2 * K + 1);
  const i0b = besselI0(beta);
  let sum = 0;
  for (let j = -K; j <= K; j++) {
    const sinc = j === 0 ? 0.5 : Math.sin((Math.PI * j) / 2) / (Math.PI * j);
    const r = j / K;
    const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[K + j] = sinc * win;
    sum += h[K + j];
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  halfband = h;
  return h;
}

/**
 * Decimate by 2 with a zero-phase half-band FIR: out[j] is centred on x[2j], the same timebase as
 * Chromium's decodeAudioData at half the rate (measured: lag 0, length floor(n/2)).
 */
export function decimate2(x: Float32Array, outLength = Math.floor(x.length / 2)): Float32Array {
  const h = halfbandTaps();
  const K = HALFBAND_K;
  const n = x.length;
  const out = new Float32Array(outLength);
  for (let j = 0; j < outLength; j++) {
    const c = 2 * j;
    let s = h[K] * (c < n ? x[c] : 0);
    // half-band: even offsets other than 0 are zero → only odd offsets contribute
    if (c - K >= 0 && c + K < n) {
      for (let k = 1; k <= K; k += 2) s += h[K + k] * (x[c - k] + x[c + k]);
    } else {
      for (let k = 1; k <= K; k += 2) {
        const a = c - k;
        const b = c + k;
        s += h[K + k] * ((a >= 0 && a < n ? x[a] : 0) + (b < n ? x[b] : 0));
      }
    }
    out[j] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// vocal presence

export interface VocalPresenceResult {
  activeFraction: number;
  relDb: number;
  present: boolean;
}

export const PRESENCE = {
  /** analysis frame */
  frameSeconds: 0.1,
  /**
   * a frame is "sung" when the vocal stem is within this many dB of the mixture … Calibrated on 10 songs
   * (tests/e2e/separation_compare.py --gate): at −30 dB the leakage of a lead instrument into the vocal
   * stem of an instrumental (dress-up-darling, 13% of frames) is indistinguishable from a sparse vocal
   * (edgerunners-ii, 13%); at −10 dB they separate (4.0% vs 7.0%; sung songs 16–64%, piano/orchestral 0–0.3%).
   */
  relThresholdDb: -10,
  /** … and above this absolute RMS (≈ −50 dBFS) */
  absFloor: 0.00316,
  /** mixture frames quieter than this (≈ −60 dBFS) are silence and not counted */
  mixFloor: 0.001,
  /** fraction of non-silent frames that must be sung */
  minActiveFraction: 0.05,
};

/** Per-100 ms vocal-stem RMS vs mixture RMS energy gate. */
export function vocalPresence(vocals: Float32Array, mix: Float32Array, sampleRate: number, p = PRESENCE): VocalPresenceResult {
  const n = Math.min(vocals.length, mix.length);
  const hop = Math.max(1, Math.round(p.frameSeconds * sampleRate));
  const rel = 10 ** (p.relThresholdDb / 20);
  let frames = 0;
  let active = 0;
  let ev = 0;
  let em = 0;
  // whole frames only (a trailing partial frame is ignored unless it is the only one)
  const count = Math.max(1, Math.floor(n / hop));
  for (let f = 0; f < count; f++) {
    const s = f * hop;
    const e = Math.min(n, s + hop);
    if (e <= s) break;
    let sv = 0;
    let sm = 0;
    for (let i = s; i < e; i++) {
      sv += vocals[i] * vocals[i];
      sm += mix[i] * mix[i];
    }
    ev += sv;
    em += sm;
    const rv = Math.sqrt(sv / (e - s));
    const rm = Math.sqrt(sm / (e - s));
    if (rm < p.mixFloor) continue;
    frames++;
    if (rv >= rm * rel && rv >= p.absFloor) active++;
  }
  const activeFraction = frames ? active / frames : 0;
  const relDb = em > 0 ? 10 * Math.log10((ev + 1e-20) / em) : -Infinity;
  return { activeFraction, relDb, present: activeFraction >= p.minActiveFraction };
}

// ---------------------------------------------------------------------------------------------
// drum onset envelope (from SCNet's drums stem; the audio itself is not kept)

/** frames per second of the drum onset envelope (the same rate as the pipeline's RMS envelope) */
export const DRUM_ENV_FPS = 100;

export const DRUM_ENV = {
  /** STFT size at 44.1 kHz (46 ms Hann window) */
  nFft: 2048,
  /** spectral-flux band */
  minHz: 30,
  maxHz: 4000,
  /** log compression: L = log(1 + gamma * |X| / mixLevel) */
  gamma: 100,
  /** flux value that maps to the top of the 8-bit range (255) */
  fullScale: 2,
};

/** RMS of each `hop`-sample frame. */
function frameRmsOf(x: Float32Array, hop: number, frames: number): Float64Array {
  const out = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    const s = t * hop;
    const e = Math.min(x.length, s + hop);
    let acc = 0;
    for (let i = s; i < e; i++) acc += x[i] * x[i];
    out[t] = e > s ? Math.sqrt(acc / (e - s)) : 0;
  }
  return out;
}

/**
 * Onset strength of the drums stem at DRUM_ENV_FPS, 8-bit (value/255 * DRUM_ENV.fullScale = flux):
 * half-wave-rectified spectral flux of the log-compressed magnitude, averaged over minHz..maxHz.
 * Magnitudes are measured relative to the MIXTURE's loudness (95th percentile of its 10 ms RMS),
 * so the envelope of a song without drums (stem = leakage only) stays near zero instead of being
 * normalised up. Frame t is centred on sample t * rate / DRUM_ENV_FPS (the frame's flux is the
 * change from frame t - 1 to t).
 */
export function drumOnsetEnvelope(drums: Float32Array, mix: Float32Array, rate: number, p = DRUM_ENV): Uint8Array {
  const hop = Math.round(rate / DRUM_ENV_FPS);
  const n = drums.length;
  const frames = Math.floor(n / hop) + 1;
  const out = new Uint8Array(frames);
  if (!n) return out;
  const rms = frameRmsOf(mix, hop, frames);
  const sorted = Array.from(rms)
    .filter((v) => v > 1e-5)
    .sort((a, b) => a - b);
  const level = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
  if (level <= 0) return out;
  const N = p.nFft;
  const fft = new RealFFT(N);
  const win = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    wsum += win[i];
  }
  const k0 = Math.max(1, Math.round((p.minHz * N) / rate));
  const k1 = Math.min(N / 2, Math.round((p.maxHz * N) / rate));
  const nb = k1 - k0 + 1;
  // |X| of a full-scale sinusoid is wsum / 2: amplitude → relative to the mixture level
  const g = p.gamma / ((wsum / 2) * level);
  const frame = new Float64Array(N);
  const re = new Float64Array(N / 2 + 1);
  const im = new Float64Array(N / 2 + 1);
  let prev = new Float64Array(nb);
  let cur = new Float64Array(nb);
  const q = 255 / p.fullScale;
  for (let t = 0; t < frames; t++) {
    const c = t * hop - N / 2;
    for (let i = 0; i < N; i++) {
      const j = c + i;
      frame[i] = j >= 0 && j < n ? drums[j] * win[i] : 0;
    }
    fft.forward(frame, re, im);
    let flux = 0;
    for (let k = k0; k <= k1; k++) {
      const v = Math.log1p(g * Math.hypot(re[k], im[k]));
      cur[k - k0] = v;
      if (t > 0 && v > prev[k - k0]) flux += v - prev[k - k0];
    }
    out[t] = Math.min(255, Math.round((flux / nb) * q));
    const sw = prev;
    prev = cur;
    cur = sw;
  }
  return out;
}
