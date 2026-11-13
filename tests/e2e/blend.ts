// Dev-only page for tests/e2e/blend.mjs: "Full song + piano model" end to end through the app's real
// transcribeAudio (in-browser SCNet separation once, then the Full song pipeline with and without the
// piano model on the separated other stem) on a synthetic band render: piano (the app's own piano
// engine) + a bass line + drums.
import { bachPreludeDemo } from '../../src/lib/music/demo';
import { renderOffline } from '../../src/lib/audio/offlineRender';
import { WavWriter } from '../../src/lib/audio/wav';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { transcribeAudio, EXTRACTION_PRESETS, PIANO_BLEND_FAILED, type TranscribeOptions } from '../../src/lib/transcription/pipeline';
import { separateStems, type SeparationResult } from '../../src/lib/separation';
import type { Note } from '../../src/lib/music/types';

const RATE = 44100;

/** The prelude's first `seconds` on the piano, with a sawtooth bass on each bar's lowest note and a kick / hi-hat pattern. */
async function bandRender(seconds: number): Promise<Blob> {
  const src = bachPreludeDemo();
  const end = Math.min(src.duration, seconds);
  const notes = src.notes.filter((n) => n.start < end - 0.3);
  const piano = await renderOffline({ notes, pedal: src.pedal.filter((p) => p.start < end), settings: { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'hall' }, start: 0, end, rate: 1, sampleRate: RATE });
  const n = piano.length;
  const out = new Float32Array(n);
  const ch = piano.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = piano.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  // bass: the lowest note of each 1.2 s span, two octaves down, a soft sawtooth
  for (let t0 = 0; t0 < end; t0 += 1.2) {
    const low = notes.filter((x) => x.start >= t0 && x.start < t0 + 1.2).sort((a, b) => a.midi - b.midi)[0];
    if (!low) continue;
    const f = 440 * 2 ** ((low.midi - 24 - 69) / 12);
    const a = Math.floor(t0 * RATE);
    const b = Math.min(n, Math.floor((t0 + 1.1) * RATE));
    for (let i = a; i < b; i++) {
      const ph = ((i - a) * f) / RATE;
      const env = Math.min(1, (i - a) / 200) * Math.exp(-(i - a) / (RATE * 1.5));
      out[i] += 0.18 * env * (2 * (ph - Math.floor(ph)) - 1);
    }
  }
  // drums: a kick every 0.6 s, a noise hi-hat on the off-beats
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let t = 0; t < end; t += 0.3) {
    const a = Math.floor(t * RATE);
    const kick = Math.round(t / 0.3) % 2 === 0;
    const len = Math.floor((kick ? 0.25 : 0.05) * RATE);
    for (let i = 0; i < len && a + i < n; i++) {
      const env = Math.exp(-i / (RATE * (kick ? 0.06 : 0.01)));
      out[a + i] += kick ? 0.35 * env * Math.sin((2 * Math.PI * (55 + 60 * Math.exp(-i / 800)) * i) / RATE) : 0.08 * env * noise();
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.9 / Math.max(peak, 1e-6);
  const buf = new AudioBuffer({ length: n, sampleRate: RATE, numberOfChannels: 1 });
  buf.getChannelData(0).set(out.map((v) => v * g));
  const wav = new WavWriter(RATE);
  wav.append(buf);
  return wav.finish();
}

let blob: Blob | null = null;
let sep: SeparationResult | null = null;

async function prepare(seconds = 20) {
  const t0 = performance.now();
  blob = await bandRender(seconds);
  sep = await separateStems(blob, () => {});
  return { seconds, separationMs: Math.round(performance.now() - t0), bass: !!sep.bass, vocals: sep.vocalPresence.present };
}

const slim = (ns: Note[]) => ns.map((n) => [n.midi, +n.start.toFixed(4), +n.dur.toFixed(4), +n.vel.toFixed(4), n.hand, n.role ?? '', n.src ?? ''].join(' '));

/** The Full song pipeline on the prepared separation; `blend` asks for the piano model. */
async function run(blend: boolean, extra: Partial<TranscribeOptions> = {}) {
  const stages: string[] = [];
  let maxBlendProgress = 0;
  const details = new Set<string>();
  const t0 = performance.now();
  const res = await transcribeAudio(
    blob!,
    EXTRACTION_PRESETS.mix,
    (e) => {
      if (stages[stages.length - 1] !== e.stage) stages.push(e.stage);
      if (e.stage === 'piano-model') {
        if (typeof e.progress === 'number') maxBlendProgress = Math.max(maxBlendProgress, e.progress);
        if (e.detail) details.add(e.detail.replace(/\d+/g, '#'));
      }
    },
    undefined,
    { separation: sep!, ...(blend ? { pianoBlend: true } : {}), ...extra },
  );
  return {
    ms: Math.round(performance.now() - t0),
    stages,
    maxBlendProgress,
    details: [...details],
    notes: slim(res.notes),
    added: res.notes.filter((n) => n.src === 'piano').length,
    pianoBlend: res.info.pianoBlend ?? null,
    specialistStored: res.posteriors?.specialist ? res.posteriors.specialist.length / 6 : 0,
    warnings: res.info.warnings,
    failedNotice: res.info.warnings.includes(PIANO_BLEND_FAILED),
  };
}

/** Cancel as soon as the piano model analyzes: must reject with AbortError promptly. */
async function runCancel() {
  const ac = new AbortController();
  let abortedAt = 0;
  try {
    await transcribeAudio(
      blob!,
      EXTRACTION_PRESETS.mix,
      (e) => {
        if (e.stage === 'piano-model' && (e.detail ?? '').startsWith('Analyzing') && !abortedAt) {
          abortedAt = performance.now();
          ac.abort();
        }
      },
      ac.signal,
      { separation: sep!, pianoBlend: true },
    );
    return { rejected: false, abortedDuringBlend: !!abortedAt };
  } catch (err) {
    return { rejected: true, name: (err as Error).name, abortedDuringBlend: !!abortedAt, rejectAfterAbortMs: abortedAt ? Math.round(performance.now() - abortedAt) : null };
  }
}

Object.assign(window, { prepare, run, runCancel });
document.getElementById('log')!.textContent = 'ready';
