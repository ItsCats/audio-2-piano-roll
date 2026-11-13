/**
 * Automatic sync of a hands video with a song (pure, unit-tested; the browser side that streams the
 * video's sound is in syncRun.ts).
 *
 * Both sounds are brought to 8 kHz mono, turned into onset envelopes (log-magnitude spectral flux at a
 * fixed 100 frames per second, whatever the sample rate) and cross-correlated over every lag with an
 * FFT. With the song's original recording as the reference, the result is refined at the sample level
 * with GCC-PHAT on raw audio. With only the song's notes as the reference, the notes become impulses
 * (sum of velocities) and a constant detector delay is corrected.
 *
 * Sign convention everywhere: video time = song time + offset.
 */

export const SYNC_SR = 8000;
/** envelope frames per second */
export const ENV_RATE = 100;
/** spectral flux peaks this much before the true onset (half-window), seen by the notes reference only */
export const NOTES_BIAS = 0.0078;
/** confidence (peak ratio) thresholds */
export const HIGH_MATCH = 1.8;
export const MEDIUM_MATCH = 1.3;
/** first and last thirds disagreeing by more than this: probably another performance */
export const DRIFT_LIMIT = 0.06;

export type SyncLevelName = 'high' | 'medium' | 'low';
export const levelFor = (ratio: number): SyncLevelName => (ratio >= HIGH_MATCH ? 'high' : ratio >= MEDIUM_MATCH ? 'medium' : 'low');

// ------------------------------------------------------------------ FFT

/** In-place radix-2 complex FFT (n a power of two); `inverse` without the 1/n scaling. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export const nextPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

// ------------------------------------------------------------------ resampling

/**
 * Streaming windowed-sinc resampler (low-pass at 0.45 × the lower rate). Feed blocks with push();
 * outputs come out as soon as their input is there; flush() gives the rest.
 */
export class Resampler {
  private buf: Float32Array = new Float32Array(0);
  /** input index of buf[0] */
  private base = 0;
  /** next output sample */
  private next = 0;
  private readonly step: number;
  private readonly half: number;
  private readonly cut: number;
  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    this.step = inRate / outRate;
    this.cut = (0.45 * Math.min(inRate, outRate)) / inRate; // cycles per input sample
    this.half = Math.max(4, Math.ceil(4 / this.cut / 2) * 2); // taps on each side
  }
  push(x: Float32Array): Float32Array {
    // keep only what later outputs still need
    const keepFrom = Math.max(0, Math.floor(this.next * this.step) - this.half - 1 - this.base);
    const rest = this.buf.subarray(keepFrom);
    const nb = new Float32Array(rest.length + x.length);
    nb.set(rest, 0);
    nb.set(x, rest.length);
    this.base += keepFrom;
    this.buf = nb;
    return this.drain(false);
  }
  flush(): Float32Array {
    return this.drain(true);
  }
  /** weights for each of PHASES fractional positions: table[phase · 2·half + (k − c + half − 1)] */
  private table: Float32Array | null = null;
  private static readonly PHASES = 512;
  private weights(): Float32Array {
    if (this.table) return this.table;
    const { half, cut } = this;
    const P = Resampler.PHASES;
    const taps = 2 * half;
    const t = new Float32Array((P + 1) * taps);
    for (let ph = 0; ph <= P; ph++) {
      const frac = ph / P;
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const d = frac + half - 1 - j; // p − k with k = c − half + 1 + j
        const x = 2 * cut * d;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / (half + 1)));
        t[ph * taps + j] = w;
        sum += w;
      }
      for (let j = 0; j < taps; j++) t[ph * taps + j] /= sum || 1;
    }
    this.table = t;
    return t;
  }
  private drain(final: boolean): Float32Array {
    const end = this.base + this.buf.length; // input samples available
    const { step, half } = this;
    if (this.inRate === this.outRate) {
      const out = this.buf.slice(this.next - this.base);
      this.next = end;
      return out;
    }
    const table = this.weights();
    const taps = 2 * half;
    const P = Resampler.PHASES;
    const maxOut = Math.max(0, Math.ceil((end - this.next * step) / step) + 1);
    const out = new Float32Array(maxOut);
    let o = 0;
    const buf = this.buf;
    for (;;) {
      const p = this.next * step;
      const c = Math.floor(p);
      if (!final && c + half >= end) break;
      if (p >= end || o >= maxOut) break;
      const row = Math.round((p - c) * P) * taps;
      let s = 0;
      let i = c - half + 1 - this.base;
      for (let j = 0; j < taps; j++, i++) if (i >= 0 && i < buf.length) s += buf[i] * table[row + j];
      out[o++] = s;
      this.next++;
    }
    return out.subarray(0, o);
  }
}

export function resample(x: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return x;
  const r = new Resampler(inRate, outRate);
  const a = r.push(x);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ------------------------------------------------------------------ envelopes

/**
 * Onset envelope: half-wave rectified log-magnitude spectral flux at ENV_RATE frames per second.
 * Frame f is centered on sample round(f·sr/100). Frame 0 is zero (the jump from silence would otherwise
 * line everything up at lag 0).
 */
export function onsetEnvelope(x: Float32Array, sr: number): Float32Array {
  const N = nextPow2(0.043 * sr);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = Math.floor((x.length * ENV_RATE) / sr);
  const env = new Float32Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  let cur = new Float64Array(N / 2);
  const norm = 2 / N;
  for (let f = 0; f < frames; f++) {
    const c = Math.round((f * sr) / ENV_RATE);
    for (let i = 0; i < N; i++) {
      const k = c - N / 2 + i;
      re[i] = k >= 0 && k < x.length ? x[k] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let s = 0;
    for (let b = 1; b < N / 2; b++) {
      const v = Math.log1p(100 * norm * Math.hypot(re[b], im[b]));
      cur[b] = v;
      const d = v - prev[b];
      if (d > 0) s += d;
    }
    env[f] = f === 0 ? 0 : s;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return env;
}

/** The song's notes as an envelope: velocity impulses at their starts. */
export function notesEnvelope(notes: { start: number; vel: number }[], frames: number): Float32Array {
  const e = new Float32Array(frames);
  for (const n of notes) {
    const f = Math.round(n.start * ENV_RATE);
    if (f >= 0 && f < frames) e[f] += Math.max(0.1, n.vel);
  }
  return e;
}

/** Gaussian smoothing, local mean removed (±0.5 s), clamped at 0, unit energy. */
export function prepEnvelope(e: Float32Array, sigma = 2): Float32Array {
  const r = Math.ceil(3 * sigma);
  const g: number[] = [];
  let gs = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    g.push(v);
    gs += v;
  }
  const s = new Float32Array(e.length);
  for (let i = 0; i < e.length; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j >= 0 && j < e.length) acc += g[k + r] * e[j];
    }
    s[i] = acc / gs;
  }
  // moving mean with a running sum
  const W = ENV_RATE / 2;
  const cs = new Float64Array(e.length + 1);
  for (let i = 0; i < e.length; i++) cs[i + 1] = cs[i] + s[i];
  const o = new Float32Array(e.length);
  let energy = 0;
  for (let i = 0; i < e.length; i++) {
    const a = Math.max(0, i - W);
    const b = Math.min(e.length, i + W + 1);
    const v = Math.max(0, s[i] - (cs[b] - cs[a]) / (b - a));
    o[i] = v;
    energy += v * v;
  }
  const n = Math.sqrt(energy) || 1;
  for (let i = 0; i < o.length; i++) o[i] /= n;
  return o;
}

// ------------------------------------------------------------------ cross-correlation

export interface XcorrResult {
  /** best lag in frames (fractional): vid[i + lag] ↔ ref[i] */
  lag: number;
  score: number;
  /** (peak − median) ÷ (best peak more than 0.4 s away − median) */
  ratio: number;
}

/**
 * Cross-correlation of two envelopes over every lag L (sum ref[i]·vid[i + L]) with enough overlap, by
 * FFT. Scores are divided by √(overlap ÷ largest overlap) so a short overlap is not favored or punished
 * too much. `range` limits the lags searched.
 */
export function xcorr(ref: Float32Array, vid: Float32Array, opts: { minOverlap?: number; range?: [number, number]; exclude?: number } = {}): XcorrResult {
  const Nr = ref.length;
  const Nv = vid.length;
  const n = nextPow2(Nr + Nv);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(ref);
  br.set(vid);
  fft(ar, ai);
  fft(br, bi);
  // conj(A)·B → c[L] = sum a[i] b[i + L]
  for (let k = 0; k < n; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k];
    const i = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = r;
    ai[k] = i;
  }
  fft(ar, ai, true);
  const maxOv = Math.min(Nr, Nv);
  const minOv = opts.minOverlap ?? Math.min(10 * ENV_RATE, Math.floor(0.5 * maxOv));
  const lo = Math.max(-(Nr - 1), opts.range?.[0] ?? -Infinity);
  const hi = Math.min(Nv - 1, opts.range?.[1] ?? Infinity);
  const lags: number[] = [];
  const scores: number[] = [];
  for (let L = Math.ceil(lo); L <= Math.floor(hi); L++) {
    const ov = Math.min(Nr, Nv - L) - Math.max(0, -L);
    if (ov < minOv) continue;
    const c = ar[(L + n) % n] / n;
    lags.push(L);
    scores.push(c / Math.sqrt(ov / maxOv));
  }
  if (!scores.length) return { lag: 0, score: 0, ratio: 0 };
  let bi0 = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k] > scores[bi0]) bi0 = k;
  const best = scores[bi0];
  // parabolic refinement (neighbors are consecutive lags)
  let frac = 0;
  if (bi0 > 0 && bi0 < scores.length - 1 && lags[bi0 + 1] - lags[bi0 - 1] === 2) {
    const y0 = scores[bi0 - 1];
    const y2 = scores[bi0 + 1];
    const den = y0 - 2 * best + y2;
    if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const ex = opts.exclude ?? 0.4 * ENV_RATE;
  let second = -Infinity;
  for (let k = 0; k < scores.length; k++) if (Math.abs(lags[k] - lags[bi0]) > ex && scores[k] > second) second = scores[k];
  const ratio = second === -Infinity ? 10 : (best - median) / Math.max(1e-12, second - median);
  return { lag: lags[bi0] + frac, score: best, ratio };
}

/**
 * GCC-PHAT between a reference window and the video around the expected lag: the sub-millisecond
 * correction (s) to `lag`, or null if no clear peak. Both signals at `sr`; lag in samples
 * (vid[j + lag] ↔ ref[j]).
 */
export function gccPhatRefine(ref: Float32Array, vid: Float32Array, sr: number, lag: number, start: number, len: number, search: number): number | null {
  const L = Math.round(lag);
  const pad = Math.ceil(search * sr) + 1;
  const n = nextPow2(len + 2 * pad);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let j = 0; j < len; j++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / len);
    const r = start + j;
    ar[j + pad] = r >= 0 && r < ref.length ? ref[r] * w : 0;
    const v = start + L + j;
    br[j + pad] = v >= 0 && v < vid.length ? vid[v] * w : 0;
  }
  fft(ar, ai);
  fft(br, bi);
  for (let k = 0; k < n; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k];
    const i = ar[k] * bi[k] - ai[k] * br[k];
    const m = Math.hypot(r, i) + 1e-12;
    ar[k] = r / m;
    ai[k] = i / m;
  }
  fft(ar, ai, true);
  const S = Math.ceil(search * sr);
  let best = -Infinity;
  let bk = 0;
  for (let k = -S; k <= S; k++) {
    const v = ar[(k + n) % n];
    if (v > best) {
      best = v;
      bk = k;
    }
  }
  // a real match stands well above the noise floor
  let mean = 0;
  for (let k = -S; k <= S; k++) mean += Math.abs(ar[(k + n) % n]);
  mean /= 2 * S + 1;
  if (!(best > 4 * mean)) return null;
  const y0 = ar[(bk - 1 + n) % n];
  const y2 = ar[(bk + 1 + n) % n];
  const den = y0 - 2 * best + y2;
  const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  return (L - lag + bk + frac) / sr;
}

// ------------------------------------------------------------------ the whole sync

export type SyncReference = { kind: 'audio'; samples: Float32Array; sr: number } | { kind: 'notes'; notes: { start: number; vel: number }[] };

export interface SyncInput {
  /** the video's sound, mono */
  video: Float32Array;
  sr: number;
  /** video time of video[0] */
  t0: number;
  ref: SyncReference;
}

export interface SyncResult {
  /** video time = song time + offset */
  offset: number;
  ratio: number;
  level: SyncLevelName;
  method: 'original' | 'notes';
  /** the first and last parts of the song disagree */
  drift: boolean;
  /** sample-level refinement worked (original only) */
  refined: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Finds where the video lines up with the song. Heavy (a few hundred ms per minute of audio). */
export function findOffset(input: SyncInput): SyncResult {
  const vid8 = input.sr === SYNC_SR ? input.video : resample(input.video, input.sr, SYNC_SR);
  const envV = prepEnvelope(onsetEnvelope(vid8, SYNC_SR), 2);
  let envR: Float32Array;
  let ref8: Float32Array | null = null;
  if (input.ref.kind === 'audio') {
    ref8 = input.ref.sr === SYNC_SR ? input.ref.samples : resample(input.ref.samples, input.ref.sr, SYNC_SR);
    envR = prepEnvelope(onsetEnvelope(ref8, SYNC_SR), 2);
  } else {
    const end = input.ref.notes.reduce((m, n) => Math.max(m, n.start), 0);
    envR = prepEnvelope(notesEnvelope(input.ref.notes, Math.ceil((end + 2) * ENV_RATE)), 3);
  }
  const main = xcorr(envR, envV);
  let lagSec = main.lag / ENV_RATE;
  if (input.ref.kind === 'notes') lagSec += NOTES_BIAS;
  // drift: the first and last thirds of the song on their own, near the main lag
  let drift = false;
  const third = Math.floor(envR.length / 3);
  if (third > 8 * ENV_RATE) {
    const near: [number, number] = [main.lag - 2 * ENV_RATE, main.lag + 2 * ENV_RATE];
    const part = (from: number) => {
      const seg = new Float32Array(envR.length);
      seg.set(envR.subarray(from, from + third), from);
      return xcorr(seg, envV, { range: near, minOverlap: 1 });
    };
    const a = part(0);
    const b = part(envR.length - third);
    if (a.score > 0 && b.score > 0 && Math.abs(a.lag - b.lag) / ENV_RATE > DRIFT_LIMIT) drift = true;
  }
  // sample-level refinement against the original: three 10 s windows where the song is busiest
  let refined = false;
  if (ref8 && main.ratio >= MEDIUM_MATCH) {
    const lagS = lagSec * SYNC_SR;
    const len = Math.min(10 * SYNC_SR, ref8.length);
    const winFrames = Math.round((len / SYNC_SR) * ENV_RATE);
    const candidates: { start: number; energy: number }[] = [];
    for (let f = 0; f + winFrames <= envR.length; f += Math.max(1, Math.floor(winFrames / 2))) {
      const startS = Math.round((f / ENV_RATE) * SYNC_SR);
      if (startS + lagS < 0 || startS + lagS + len > vid8.length) continue;
      let e = 0;
      for (let k = f; k < f + winFrames; k++) e += envR[k];
      candidates.push({ start: startS, energy: e });
    }
    candidates.sort((a, b) => b.energy - a.energy);
    const picked: number[] = [];
    for (const c of candidates) {
      if (picked.every((p) => Math.abs(p - c.start) >= len)) picked.push(c.start);
      if (picked.length === 3) break;
    }
    const fixes = picked.map((s) => gccPhatRefine(ref8!, vid8, SYNC_SR, lagS, s, len, 0.03)).filter((x): x is number => x !== null);
    if (fixes.length) {
      lagSec += median(fixes);
      refined = true;
    }
  }
  return { offset: input.t0 + lagSec, ratio: main.ratio, level: levelFor(main.ratio), method: input.ref.kind === 'audio' ? 'original' : 'notes', drift, refined };
}
