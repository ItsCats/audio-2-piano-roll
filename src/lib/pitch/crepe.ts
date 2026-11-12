/**
 * CREPE pitch tracking DSP (pure functions, no model): what torchcrepe does around the network.
 *
 *   22.05 kHz → 16 kHz resampling (windowed sinc, 320/441 polyphase)
 *   1024-sample frames centred on every hop (10 ms), zero-padded by 512 at both ends,
 *   each frame mean-centred and divided by its standard deviation (unbiased, as torch.std)
 *   network → 360 sigmoid activations per frame (bin b = 1997.38 + 20·b cents above 10 Hz)
 *   Viterbi decoding over the bins inside [fmin, fmax] with torchcrepe's transition matrix
 *   (triangular, ±11 bins, rows normalised) and its emission (softmax over the activations, which
 *   for a path search is the activation itself: the per-frame normaliser is a constant)
 *   periodicity = the activation at the decoded bin; pitch = local weighted average of the
 *   activations within ±4 bins of the decoded bin (CREPE's to_local_average_cents, instead of
 *   torchcrepe's random dither).
 *
 * Frames far below the stem's loudness are not run through the network (they could never pass
 * the voicing gate); the decoder treats them as uninformative.
 */

export const CREPE_RATE = 16000;
export const CREPE_WINDOW = 1024;
export const CREPE_BINS = 360;
export const CENTS_PER_BIN = 20;
export const CENTS_OFFSET = 1997.3794084376191;

export const binToCents = (b: number): number => CENTS_PER_BIN * b + CENTS_OFFSET;
export const centsToHz = (c: number): number => 10 * 2 ** (c / 1200);
export const hzToCents = (hz: number): number => 1200 * Math.log2(hz / 10);
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);
/** torchcrepe.convert.frequency_to_bins: floor for fmin, ceil for fmax */
export const hzToBin = (hz: number, round: (x: number) => number = Math.floor): number => round((hzToCents(hz) - CENTS_OFFSET) / CENTS_PER_BIN);

export interface BinRange {
  /** first allowed bin (inclusive) */
  lo: number;
  /** end (exclusive), like torchcrepe's probabilities[:, maxidx:] = -inf */
  hi: number;
}

export function binRange(fmin: number, fmax: number): BinRange {
  const lo = Math.max(0, hzToBin(fmin));
  const hi = Math.min(CREPE_BINS, hzToBin(fmax, Math.ceil));
  if (hi <= lo) throw new Error(`Empty CREPE pitch range ${fmin}–${fmax} Hz`);
  return { lo, hi };
}

// ---------------------------------------------------------------- resampling

function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Rational resampler (windowed sinc, Kaiser β = 8.6, cutoff 0.94 × the lower Nyquist,
 * `zeros` zero crossings per side). Output sample n sits at input time n·from/to; the first
 * output sample coincides with the first input sample, so the timebase is preserved.
 */
export function resample(x: Float32Array, from: number, to: number, zeros = 16): Float32Array {
  if (from === to) return x.slice();
  const g = gcd(from, to);
  const up = to / g;
  const down = from / g;
  const nOut = Math.floor(((x.length - 1) * up) / down) + 1;
  const out = new Float32Array(Math.max(0, nOut));
  const cutoff = 0.94 * Math.min(1, to / from); // relative to the input Nyquist
  const half = Math.ceil(zeros / cutoff);
  const taps = 2 * half;
  const beta = 8.6;
  const i0b = bessel0(beta);
  // one kernel per output phase (the fractional input position repeats every `up` outputs)
  const kernels: Float32Array[] = [];
  for (let p = 0; p < up; p++) {
    const frac = ((p * down) % up) / up; // position past the integer input sample
    const k = new Float32Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = j - half + 1 - frac; // distance in input samples from the output instant
      const w = Math.abs(t) >= half ? 0 : bessel0(beta * Math.sqrt(1 - (t / half) ** 2)) / i0b;
      const s = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
      k[j] = w * s * cutoff;
      sum += k[j];
    }
    for (let j = 0; j < taps; j++) k[j] /= sum; // unity DC gain per phase
    kernels.push(k);
  }
  const n = x.length;
  for (let o = 0; o < nOut; o++) {
    const pos = Math.floor((o * down) / up);
    const k = kernels[o % up];
    const base = pos - half + 1;
    let acc = 0;
    if (base >= 0 && base + taps <= n) {
      for (let j = 0; j < taps; j++) acc += k[j] * x[base + j];
    } else {
      for (let j = 0; j < taps; j++) {
        const i = base + j;
        if (i >= 0 && i < n) acc += k[j] * x[i];
      }
    }
    out[o] = acc;
  }
  return out;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

// ---------------------------------------------------------------- framing

/** Number of frames torchcrepe produces with pad=True: 1 + floor(len / hop). */
export const frameCount = (len: number, hop: number): number => 1 + Math.floor(len / hop);

/**
 * Write frame `i` (centred on sample i·hop, zero outside the signal) into `out`, mean-centred and
 * scaled to unit (unbiased) standard deviation. Returns the frame's RMS before normalisation.
 */
export function writeFrame(audio: Float32Array, i: number, hop: number, out: Float32Array, offset = 0): number {
  const start = i * hop - CREPE_WINDOW / 2;
  const n = audio.length;
  let sum = 0;
  let sq = 0;
  for (let j = 0; j < CREPE_WINDOW; j++) {
    const k = start + j;
    const v = k >= 0 && k < n ? audio[k] : 0;
    out[offset + j] = v;
    sum += v;
    sq += v * v;
  }
  const mean = sum / CREPE_WINDOW;
  const varU = Math.max(0, (sq - CREPE_WINDOW * mean * mean) / (CREPE_WINDOW - 1));
  const sd = Math.max(1e-10, Math.sqrt(varU));
  for (let j = 0; j < CREPE_WINDOW; j++) out[offset + j] = (out[offset + j] - mean) / sd;
  return Math.sqrt(sq / CREPE_WINDOW);
}

/** RMS of every frame (same framing as writeFrame), without normalising. */
export function frameRms(audio: Float32Array, hop: number): Float32Array {
  const nf = frameCount(audio.length, hop);
  const out = new Float32Array(nf);
  // prefix sums of squares (float64) for O(1) per frame
  const pre = new Float64Array(audio.length + 1);
  for (let i = 0; i < audio.length; i++) pre[i + 1] = pre[i] + audio[i] * audio[i];
  for (let i = 0; i < nf; i++) {
    const a = Math.max(0, i * hop - CREPE_WINDOW / 2);
    const b = Math.min(audio.length, i * hop + CREPE_WINDOW / 2);
    out[i] = b > a ? Math.sqrt((pre[b] - pre[a]) / CREPE_WINDOW) : 0;
  }
  return out;
}

/** q-quantile (0..1) of the values above `floor`. */
export function quantile(x: Float32Array, q: number, floor = 1e-7): number {
  const v = Array.from(x).filter((a) => a > floor).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}

// ---------------------------------------------------------------- Viterbi

/** torchcrepe's transition reach: max(12 - |i - j|, 0) is non-zero for |i - j| <= 11. */
export const TRANSITION_REACH = 11;

/**
 * Online Viterbi decoder over the bins of `range` with torchcrepe's transition matrix
 * (np.maximum(12 - |i - j|, 0), each row normalised to sum 1, within the allowed bins) and
 * uniform initial probabilities. Emission log-likelihood of bin b = `scale` × activation[b]
 * (scale 1 == torchcrepe: softmax over the activations, up to a per-frame constant).
 * Backpointers are kept as int8 offsets: 1 byte per allowed bin per frame.
 */
export class ViterbiDecoder {
  readonly lo: number;
  readonly width: number;
  private logT: Float64Array; // [width][2R+1]: log transition from i = j + d to j... stored per destination
  private delta: Float64Array;
  private next: Float64Array;
  private back: Int8Array;
  private frames = 0;
  private capacity: number;

  constructor(range: BinRange, expectedFrames = 1024, private scale = 1) {
    this.lo = range.lo;
    this.width = range.hi - range.lo;
    const R = TRANSITION_REACH;
    const W = this.width;
    // rows normalised over all 360 bins, as torchcrepe/librosa do: out-of-range bins have zero
    // emission probability, so they are never on the path, but they keep their share of each
    // row. (Normalising within the allowed bins instead gives the two edge states a higher
    // self-transition than any other state - with CREPE's weak emissions the path then sticks
    // to fmin / fmax.)
    const rowSum = new Float64Array(W);
    for (let i = 0; i < W; i++) {
      const abs = i + this.lo;
      for (let d = -R; d <= R; d++) if (abs + d >= 0 && abs + d < CREPE_BINS) rowSum[i] += 12 - Math.abs(d);
    }
    this.logT = new Float64Array(W * (2 * R + 1));
    for (let j = 0; j < W; j++) {
      for (let d = -R; d <= R; d++) {
        const i = j + d; // source state
        this.logT[j * (2 * R + 1) + d + R] = i >= 0 && i < W ? Math.log((12 - Math.abs(d)) / rowSum[i]) : -Infinity;
      }
    }
    this.delta = new Float64Array(W).fill(Math.log(1 / W));
    this.next = new Float64Array(W);
    this.capacity = Math.max(16, expectedFrames);
    this.back = new Int8Array(this.capacity * W);
  }

  get length(): number {
    return this.frames;
  }

  /**
   * Add one frame. `act` holds the activations of the allowed bins (act[k] is bin lo + k), or is
   * null for a frame without information (uniform emission).
   */
  step(act: ArrayLike<number> | null): void {
    const W = this.width;
    const R = TRANSITION_REACH;
    const S = 2 * R + 1;
    if (this.frames >= this.capacity) {
      const grown = new Int8Array(this.capacity * 2 * W);
      grown.set(this.back);
      this.back = grown;
      this.capacity *= 2;
    }
    const back = this.back;
    const row = this.frames * W;
    const delta = this.delta;
    const next = this.next;
    if (this.frames === 0) {
      // first frame: initial distribution × emission, no transition
      for (let j = 0; j < W; j++) {
        next[j] = delta[j] + (act ? this.scale * act[j] : 0);
        back[row + j] = 0;
      }
    } else {
      const logT = this.logT;
      for (let j = 0; j < W; j++) {
        let best = -Infinity;
        let arg = 0;
        const lo = Math.max(-R, -j);
        const hi = Math.min(R, W - 1 - j);
        const base = j * S + R;
        for (let d = lo; d <= hi; d++) {
          const v = delta[j + d] + logT[base + d];
          if (v > best) {
            best = v;
            arg = d;
          }
        }
        next[j] = best + (act ? this.scale * act[j] : 0);
        back[row + j] = arg;
      }
    }
    // renormalise (keeps the numbers bounded on long songs; does not change the argmax path)
    let m = -Infinity;
    for (let j = 0; j < W; j++) if (next[j] > m) m = next[j];
    for (let j = 0; j < W; j++) delta[j] = next[j] - m;
    this.frames++;
  }

  /** Best path, as absolute bin indices (0..359). */
  finish(): Int16Array {
    const W = this.width;
    const n = this.frames;
    const path = new Int16Array(n);
    if (!n) return path;
    let j = 0;
    for (let k = 1; k < W; k++) if (this.delta[k] > this.delta[j]) j = k;
    for (let t = n - 1; t >= 0; t--) {
      path[t] = j + this.lo;
      if (t > 0) j += this.back[t * W + j];
    }
    return path;
  }
}

/**
 * Pitch (Hz) from the activations around a decoded bin: weighted average of the bin centres in
 * cents within ±4 bins (clipped to the allowed range), as CREPE's to_local_average_cents.
 */
export function localAverageHz(act: ArrayLike<number>, bin: number, range: BinRange): number {
  const a = Math.max(range.lo, bin - 4);
  const b = Math.min(range.hi - 1, bin + 4);
  let w = 0;
  let c = 0;
  for (let k = a; k <= b; k++) {
    const p = act[k - range.lo];
    w += p;
    c += p * binToCents(k);
  }
  return centsToHz(w > 0 ? c / w : binToCents(bin));
}

// ---------------------------------------------------------------- filters

/** Running median over `width` (odd) samples, edges use the available samples. */
export function medianFilter(x: Float32Array, width: number): Float32Array {
  const h = Math.floor(width / 2);
  const out = new Float32Array(x.length);
  const buf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    buf.length = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(x.length - 1, i + h); k++) buf.push(x[k]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}
