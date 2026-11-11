/**
 * Tempo estimation and beat tracking.
 *
 * 1. An onset-strength envelope is built from note onsets at 100 fps.
 * 2. Global tempo: autocorrelation of the envelope weighted by a log-normal tempo prior
 *    (centred at 110 BPM), with parabolic peak refinement.
 * 3. Beat times: dynamic-programming beat tracker (D. Ellis, "Beat Tracking by Dynamic
 *    Programming", 2007) — follows gradual tempo changes of real performances.
 * 4. Meter (3 vs 4) and downbeat phase from bass/accent periodicity on the beat grid.
 */
import type { Note, TempoInfo } from './types';

const FPS = 100;

export function onsetEnvelopeFromNotes(notes: Note[], duration: number): Float32Array {
  const n = Math.max(1, Math.ceil(duration * FPS) + 1);
  const env = new Float32Array(n);
  for (const note of notes) {
    const i = Math.round(note.start * FPS);
    if (i < 0 || i >= n) continue;
    // low notes and loud notes carry more rhythmic weight
    const w = (0.4 + note.vel) * (note.midi < 55 ? 1.3 : 1);
    env[i] += w;
  }
  // gaussian smoothing (sigma 20ms)
  const out = new Float32Array(n);
  const k = [0.05, 0.25, 0.4, 0.25, 0.05];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) s += env[idx] * k[j + 2];
    }
    out[i] = s;
  }
  return out;
}

/** Onset envelope of the lowest sounding voice (local bass line), weighted by duration. */
export function bassEnvelope(notes: Note[], duration: number): Float32Array {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const bass: Note[] = [];
  let j0 = 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    while (j0 < sorted.length && sorted[j0].start < n.start - 1) j0++;
    let lo = Infinity;
    for (let j = j0; j < sorted.length && sorted[j].start <= n.start + 1; j++) lo = Math.min(lo, sorted[j].midi);
    if (n.midi <= lo + 4) bass.push({ ...n, vel: n.vel * Math.min(2, 0.5 + n.dur) });
  }
  return onsetEnvelopeFromNotes(bass, duration);
}

function autocorr(env: Float32Array, maxLag: number): Float32Array {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - mean;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac[lag] = s / (n - lag);
  }
  const z = ac[0] || 1;
  for (let lag = 0; lag < ac.length; lag++) ac[lag] /= z;
  return ac;
}

function estimatePeriod(env: Float32Array, bassEnv?: Float32Array): { period: number; confidence: number } {
  const minLag = Math.floor(FPS * 60 / 220);
  const maxLag = Math.ceil(FPS * 60 / 40);
  const ac = autocorr(env, maxLag * 4);
  const acBass = bassEnv ? autocorr(bassEnv, maxLag * 4) : null;
  let best = -1;
  let bestScore = -Infinity;
  let total = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    // reward lags whose double also correlates (metrical support)
    const dbl = Math.max(0, ac[lag * 2]);
    // the bass line usually moves on beats, half-bars or bars: reward lags it supports
    const bassSupport = acBass ? Math.max(0, acBass[lag]) + Math.max(0, acBass[lag * 2]) + 0.5 * Math.max(0, acBass[lag * 4]) : 0;
    const score = (ac[lag] + 0.5 * dbl + 0.6 * bassSupport) * prior;
    if (ac[lag] > 0) {
      total += ac[lag];
      count++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // parabolic interpolation
  const y0 = ac[best - 1];
  const y1 = ac[best];
  const y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const avg = count ? total / count : 0;
  const confidence = avg > 0 ? Math.max(0, Math.min(1, (y1 / avg - 1) / 2)) : 0;
  return { period: best + shift, confidence };
}

function trackBeatsDP(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  // normalise envelope
  let sd = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  for (let i = 0; i < n; i++) sd += (env[i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) local[i] = env[i] / sd;

  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const pMin = Math.round(period / 2);
  const pMax = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestP = -1;
    for (let p = t - pMax; p <= t - pMin; p++) {
      if (p < 0) continue;
      const d = Math.log((t - p) / period);
      const v = score[p] - tightness * d * d;
      if (v > best) {
        best = v;
        bestP = p;
      }
    }
    score[t] = local[t] + (bestP >= 0 ? best : 0);
    back[t] = bestP;
  }
  // pick the best end within the final period
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (score[t] > bestEnd) {
      bestEnd = score[t];
      end = t;
    }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  return beats.map((b) => b / FPS);
}

function strengthAt(env: Float32Array, t: number): number {
  const i = Math.round(t * FPS);
  let m = 0;
  for (let j = i - 3; j <= i + 3; j++) if (j >= 0 && j < env.length) m = Math.max(m, env[j]);
  return m;
}

function bassStrength(notes: Note[], beats: number[]): number[] {
  // weight of low-register onsets near each beat (bar starts tend to have bass)
  const out = new Array(beats.length).fill(0);
  const sorted = notes.filter((n) => n.midi < 60).sort((a, b) => a.start - b.start);
  let j = 0;
  for (let b = 0; b < beats.length; b++) {
    const t = beats[b];
    while (j < sorted.length && sorted[j].start < t - 0.07) j++;
    let k = j;
    while (k < sorted.length && sorted[k].start <= t + 0.07) {
      out[b] += (0.5 + sorted[k].vel) * Math.min(2, sorted[k].dur + 0.25);
      k++;
    }
  }
  return out;
}

export function estimateTempo(notes: Note[], duration: number): TempoInfo {
  const fallback: TempoInfo = {
    bpm: 120,
    beats: [],
    beatsPerBar: 4,
    downbeatIndex: 0,
    confidence: 0,
    source: 'estimated',
  };
  if (notes.length < 8 || duration < 3) {
    fallback.beats = regularBeats(120, 0, duration);
    return fallback;
  }
  const env = onsetEnvelopeFromNotes(notes, duration);
  const { period, confidence } = estimatePeriod(env, bassEnvelope(notes, duration));
  let beats = trackBeatsDP(env, period);
  if (beats.length < 4) beats = regularBeats((60 * FPS) / period, notes[0]?.start ?? 0, duration);
  // median inter-beat interval is a more robust BPM than the autocorrelation lag
  const ibis = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const medIbi = ibis[Math.floor(ibis.length / 2)] || period / FPS;
  const bpm = Math.round((60 / medIbi) * 10) / 10;

  // meter & downbeat
  const bass = bassStrength(notes, beats);
  const accents = beats.map((b, i) => strengthAt(env, b) * 0.5 + bass[i]);
  let bestMeter = 4;
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (const meter of [4, 3]) {
    for (let phase = 0; phase < meter; phase++) {
      let on = 0;
      let off = 0;
      let cOn = 0;
      let cOff = 0;
      accents.forEach((a, i) => {
        if ((i - phase) % meter === 0) {
          on += a;
          cOn++;
        } else {
          off += a;
          cOff++;
        }
      });
      const contrast = (cOn ? on / cOn : 0) - (cOff ? off / cOff : 0);
      const score = contrast * (meter === 4 ? 1.15 : 1); // 4/4 is far more common
      if (score > bestScore) {
        bestScore = score;
        bestMeter = meter;
        bestPhase = phase;
      }
    }
  }
  return {
    bpm,
    beats,
    beatsPerBar: bestMeter,
    downbeatIndex: bestPhase,
    confidence,
    source: 'estimated',
  };
}

export function regularBeats(bpm: number, offset: number, duration: number): number[] {
  const period = 60 / bpm;
  const beats: number[] = [];
  let t = offset;
  while (t - period >= 0) t -= period;
  for (; t <= duration + period; t += period) beats.push(Math.round(t * 10000) / 10000);
  return beats;
}

/** Beat period at time t (seconds). */
export function beatPeriodAt(beats: number[], t: number, bpm: number): number {
  if (beats.length < 2) return 60 / bpm;
  const i = upperBound(beats, t);
  if (i <= 0) return beats[1] - beats[0];
  if (i >= beats.length) return beats[beats.length - 1] - beats[beats.length - 2];
  return beats[i] - beats[i - 1];
}

/** Index of first element > t. */
export function upperBound(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Continuous beat position (in beats) for a time, extrapolating outside the tracked range. */
export function timeToBeat(beats: number[], t: number, bpm: number): number {
  if (beats.length < 2) return t / (60 / bpm);
  const i = upperBound(beats, t);
  if (i <= 0) {
    const p = beats[1] - beats[0];
    return (t - beats[0]) / p;
  }
  if (i >= beats.length) {
    const p = beats[beats.length - 1] - beats[beats.length - 2];
    return beats.length - 1 + (t - beats[beats.length - 1]) / p;
  }
  return i - 1 + (t - beats[i - 1]) / (beats[i] - beats[i - 1]);
}

export function beatToTime(beats: number[], b: number, bpm: number): number {
  if (beats.length < 2) return b * (60 / bpm);
  if (b <= 0) return beats[0] + b * (beats[1] - beats[0]);
  const last = beats.length - 1;
  if (b >= last) return beats[last] + (b - last) * (beats[last] - beats[last - 1]);
  const i = Math.floor(b);
  return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
}

/** Snap a time to the nearest subdivision of the beat grid. */
export function snapTime(beats: number[], bpm: number, t: number, subdivision: number): number {
  const b = timeToBeat(beats, t, bpm);
  const snapped = Math.round(b * subdivision) / subdivision;
  return beatToTime(beats, snapped, bpm);
}
