import type { ReverbType } from './types';

const REVERBS: Record<Exclude<ReverbType, 'off'>, { seconds: number; preDelay: number; damping: number }> = {
  studio: { seconds: 0.9, preDelay: 0.004, damping: 0.6 },
  room: { seconds: 1.5, preDelay: 0.008, damping: 0.5 },
  hall: { seconds: 2.8, preDelay: 0.022, damping: 0.42 },
  cathedral: { seconds: 5, preDelay: 0.04, damping: 0.32 },
};

const irCache = new Map<string, AudioBuffer>();

/** Seeded PRNG so impulse responses (and therefore exports) are deterministic. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthesises a stereo impulse response: decorrelated noise with an exponential (-60 dB at
 * `seconds`) envelope, progressive high-frequency damping (air/wall absorption), a short
 * pre-delay and a handful of early reflections.
 */
export function impulseResponse(ctx: BaseAudioContext, type: Exclude<ReverbType, 'off'>): AudioBuffer {
  const key = `${type}@${ctx.sampleRate}`;
  const cached = irCache.get(key);
  if (cached) return cached;
  const { seconds, preDelay, damping } = REVERBS[type];
  const sr = ctx.sampleRate;
  const len = Math.ceil((seconds + preDelay) * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(preDelay * sr);
  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32(1234 + c * 999);
    const data = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.pow(10, (-3 * t) / seconds); // -60 dB at `seconds`
      const noise = rnd() * 2 - 1;
      // one-pole low-pass whose cutoff falls over time
      const a = Math.min(0.98, damping + (t / seconds) * 0.5);
      lp = lp * a + noise * (1 - a);
      data[i] = lp * env * (1 + damping);
    }
    // early reflections
    const er = [0.011, 0.017, 0.023, 0.031, 0.043, 0.057];
    er.forEach((d, k) => {
      const idx = pre + Math.floor((d + c * 0.0013 * (k + 1)) * sr);
      if (idx < len) data[idx] += (0.5 / (k + 1.5)) * (k % 2 ? -1 : 1);
    });
  }
  // normalise energy so different rooms sit at similar loudness
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) energy += d[i] * d[i];
  }
  const norm = 1 / Math.sqrt(energy / 2 || 1);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= norm * 0.9;
  }
  irCache.set(key, buf);
  return buf;
}

/** Simple stereo chorus: two LFO-modulated short delays mixed with the dry signal. */
export class Chorus {
  readonly input: GainNode;
  readonly output: GainNode;
  private wet: GainNode;
  private dry: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.input.connect(this.dry).connect(this.output);
    const merger = ctx.createChannelMerger(2);
    const splitter = ctx.createChannelSplitter(2);
    this.input.connect(splitter);
    [0, 1].forEach((ch) => {
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = 0.018 + ch * 0.004;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.6 + ch * 0.17;
      const depth = ctx.createGain();
      depth.gain.value = 0.0025;
      lfo.connect(depth).connect(delay.delayTime);
      lfo.start(0);
      splitter.connect(delay, ch);
      delay.connect(merger, 0, ch);
    });
    merger.connect(this.wet).connect(this.output);
    this.set(0);
  }
  set(amount: number, time = 0) {
    this.wet.gain.setValueAtTime(amount * 0.6, time);
    this.dry.gain.setValueAtTime(1 - amount * 0.25, time);
  }
}
