// Dev-only page for tests/e2e/piano-part.mjs: renders its test song, the demo prelude's first seconds on
// the app's own piano with a formant-synthesized "singer" on top at the piano's level (a pulse train with
// spectral tilt, 5.5 Hz vibrato, five vowels of five formants each, legato glides, a stepwise melody in
// MIDI 60-76). Checked offline with the server's SCNet code: the voice goes to the vocal stem
// (correlation 0.998 with the true voice; 0.5 % of it left in the accompaniment), so the test is meaningful.
import { bachPreludeDemo } from '../../src/lib/music/demo';
import { renderOffline } from '../../src/lib/audio/offlineRender';
import { WavWriter } from '../../src/lib/audio/wav';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';

const SR = 44100;
const VOWELS: [number, number][][] = [
  [[800, 80], [1150, 90], [2900, 120], [3900, 130], [4950, 140]], // a
  [[400, 60], [1700, 80], [2600, 120], [3200, 120], [3580, 120]], // e
  [[270, 60], [2140, 90], [2950, 100], [3900, 120], [4950, 120]], // i
  [[450, 70], [800, 80], [2830, 100], [3500, 130], [4950, 135]], // o
  [[325, 50], [700, 60], [2530, 170], [3500, 180], [4950, 200]], // u
];
const GAINS = [1, 0.6, 0.35, 0.2, 0.1];

/** a deterministic random source */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** [start s, length s, midi, vowel] notes of a stepwise sung line in MIDI 60-76 */
function melody(seconds: number): [number, number, number, number][] {
  const r = rng(3);
  const out: [number, number, number, number][] = [];
  let t = 0.3;
  let m = 67;
  const lens = [0.35, 0.5, 0.75, 1.0];
  const steps = [-4, -2, -1, 0, 1, 2, 3, 5];
  while (t < seconds - 1) {
    const ln = lens[Math.floor(r() * lens.length)];
    m = Math.max(60, Math.min(76, m + steps[Math.floor(r() * steps.length)]));
    out.push([t, ln * 0.92, m, Math.floor(r() * 5)]);
    t += ln;
    if (r() < 0.12) t += 0.5;
  }
  return out;
}

function resonate(x: Float32Array, f: number, bw: number, out: Float32Array, gain: number, mask: Uint8Array, vowel: number) {
  const r = Math.exp((-Math.PI * bw) / SR);
  const c1 = 2 * r * Math.cos((2 * Math.PI * f) / SR);
  const c2 = -r * r;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (1 - r) * x[i] + c1 * y1 + c2 * y2;
    y2 = y1;
    y1 = y;
    if (mask[i] === vowel) out[i] += gain * y;
  }
}

function voice(mel: [number, number, number, number][], n: number): Float32Array {
  const r = rng(1);
  const f0 = new Float32Array(n);
  const env = new Float32Array(n);
  const vow = new Uint8Array(n).fill(255);
  for (const [s, ln, m, v] of mel) {
    const a = Math.floor(s * SR);
    const b = Math.min(n, Math.floor((s + ln) * SR));
    const att = Math.floor(Math.min(0.06, ln / 4) * SR);
    const rel = Math.floor(0.08 * SR);
    for (let i = a; i < b; i++) {
      f0[i] = 440 * 2 ** ((m - 69) / 12);
      let e = 1;
      if (i - a < att) e = (i - a) / att;
      if (b - i < rel) e *= (b - i) / rel;
      env[i] = e;
      vow[i] = v;
    }
  }
  // glides: hold the pitch through gaps, smooth it in the log domain over 40 ms
  let last = 220;
  const lf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (f0[i] > 0) last = f0[i];
    lf[i] = Math.log(last);
  }
  const k = Math.floor(0.04 * SR);
  const sm = new Float32Array(n);
  let acc = 0;
  for (let i = -k; i <= k; i++) acc += lf[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n; i++) {
    sm[i] = acc / (2 * k + 1);
    acc += lf[Math.min(n - 1, i + k + 1)] - lf[Math.max(0, i - k)];
  }
  const phase0 = r() * 6;
  const src = new Float32Array(n);
  let ph = 0;
  let tilt = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vib = ((0.35 / 12) * Math.log(2) * Math.sin(2 * Math.PI * 5.5 * t + phase0)) * Math.min(1, t % 4);
    ph += Math.exp(sm[i] + vib) / SR;
    const saw = 2 * (ph % 1) - 1;
    tilt = saw + 0.97 * tilt;
    src[i] = tilt;
    peak = Math.max(peak, Math.abs(tilt));
  }
  for (let i = 0; i < n; i++) src[i] = src[i] / peak + 0.03 * (r() * 2 - 1);
  const out = new Float32Array(n);
  VOWELS.forEach((formants, v) => formants.forEach(([f, bw], j) => resonate(src, f, bw, out, GAINS[j], vow, v)));
  for (let i = 0; i < n; i++) out[i] *= env[i];
  return out;
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** The test song as a WAV (base64), its piano notes (the reference) and the sung line. */
async function render(seconds = 20, voiceDb = 0) {
  const src = bachPreludeDemo();
  const end = Math.min(src.duration, seconds);
  const notes = src.notes.filter((n) => n.start < end - 0.3);
  const piano = await renderOffline({ notes, pedal: src.pedal.filter((p) => p.start < end), settings: { ...DEFAULT_AUDIO_SETTINGS }, start: 0, end, rate: 1, sampleRate: SR });
  const n = piano.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < piano.numberOfChannels; c++) {
    const d = piano.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / piano.numberOfChannels;
  }
  const mel = melody(end);
  const v = voice(mel, n);
  // the singer at the piano's level (active RMS), +voiceDb
  const active = (x: Float32Array) => rms(x.filter((s) => Math.abs(s) > 1e-4));
  const g = (active(mono) / Math.max(1e-9, active(v))) * 10 ** (voiceDb / 20);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    out[i] = mono[i] + g * v[i];
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const k = 0.9 / Math.max(peak, 1e-6);
  const buf = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 1 });
  buf.getChannelData(0).set(out.map((x) => x * k));
  const wav = new WavWriter(SR);
  wav.append(buf);
  const bytes = new Uint8Array(await wav.finish().arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    wav: btoa(bin),
    seconds: end,
    reference: notes.map((x) => [x.midi, +x.start.toFixed(4)]),
    sung: mel.map(([s, ln, m]) => [+s.toFixed(3), +ln.toFixed(3), m]),
  };
}

Object.assign(window, { render });
document.getElementById('log')!.textContent = 'ready';
