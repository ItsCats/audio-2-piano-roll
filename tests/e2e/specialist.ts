// Dev-only page for tests/e2e/specialist.mjs: the high-accuracy piano model engine end to end
// (decode → the ByteDance piano model in its worker → regression post-processing → hands, beats,
// key) through the app's real transcribeAudio, on a short excerpt, scored note by note.
import { bachPreludeDemo } from '../../src/lib/music/demo';
import { renderOffline } from '../../src/lib/audio/offlineRender';
import { WavWriter } from '../../src/lib/audio/wav';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { transcribeAudio, EXTRACTION_PRESETS, type TranscriptionResult } from '../../src/lib/transcription/pipeline';
import { decodeToRate } from '../../src/lib/transcription/decode';

/** A reference or detected note, times in seconds from the start of the excerpt. */
interface RefNote {
  midi: number;
  start: number;
  end: number;
}

type Engine = 'specialist' | 'basic-pitch';

/**
 * Greedy one-to-one matching, pitch exact, onset within `tol` (as tests/e2e/harness.ts). With
 * offsets, a match also needs the offset within max(50 ms, 20 % of the reference duration) — the
 * mir_eval onset+offset rule. Only notes whose onset lies in [lo, hi] count on either side, so notes
 * cut by the excerpt's edges are not scored.
 */
function score(ref: RefNote[], est: RefNote[], lo: number, hi: number, offsets = false, tol = 0.05) {
  const R = ref.filter((n) => n.start >= lo && n.start <= hi);
  const E = est.filter((n) => n.start >= lo && n.start <= hi).sort((a, b) => a.start - b.start);
  const used = new Uint8Array(E.length);
  let tp = 0;
  const errs: number[] = [];
  for (const r of R) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (used[i] || e.midi !== r.midi) continue;
      const d = Math.abs(e.start - r.start);
      if (d > tol || d >= bestD) continue;
      if (offsets && Math.abs(e.end - r.end) > Math.max(0.05, 0.2 * (r.end - r.start))) continue;
      best = i;
      bestD = d;
    }
    if (best >= 0) {
      used[best] = 1;
      tp++;
      errs.push(E[best].start - r.start);
    }
  }
  const p = E.length ? tp / E.length : 0;
  const rc = R.length ? tp / R.length : 0;
  const f1 = p + rc ? (2 * p * rc) / (p + rc) : 0;
  const sorted = errs.map(Math.abs).sort((a, b) => a - b);
  return {
    f1: +f1.toFixed(3),
    precision: +p.toFixed(3),
    recall: +rc.toFixed(3),
    nRef: R.length,
    nEst: E.length,
    medianOnsetErrMs: sorted.length ? +(sorted[sorted.length >> 1] * 1000).toFixed(1) : null,
  };
}

async function transcribe(blob: Blob, engine: Engine, signal?: AbortSignal) {
  const stages: Record<string, number> = {};
  let last = performance.now();
  let lastStage = '';
  let maxProgress = 0;
  const t0 = performance.now();
  const res: TranscriptionResult = await transcribeAudio(
    blob,
    EXTRACTION_PRESETS.piano,
    (e) => {
      if (e.stage !== lastStage) {
        const now = performance.now();
        if (lastStage) stages[lastStage] = (stages[lastStage] ?? 0) + now - last;
        last = now;
        lastStage = e.stage;
      }
      if (typeof e.progress === 'number') maxProgress = Math.max(maxProgress, e.progress);
    },
    signal,
    engine === 'specialist' ? { engine: 'piano-specialist' } : {},
  );
  if (lastStage) stages[lastStage] = (stages[lastStage] ?? 0) + performance.now() - last;
  return { res, ms: Math.round(performance.now() - t0), stagesMs: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Math.round(v)])), maxProgress };
}

function summary(engine: Engine, run: Awaited<ReturnType<typeof transcribe>>, ref: RefNote[], lo: number, hi: number) {
  const est = run.res.notes.map((n) => ({ midi: n.midi, start: n.start, end: n.start + n.dur }));
  const vel = run.res.notes.map((n) => n.vel);
  return {
    engine,
    ms: run.ms,
    stagesMs: run.stagesMs,
    maxProgress: run.maxProgress,
    backend: run.res.info.backend,
    method: run.res.info.method,
    hasPosteriors: !!run.res.posteriors,
    warnings: run.res.info.warnings,
    notes: run.res.notes.length,
    velocityRange: vel.length ? [+Math.min(...vel).toFixed(3), +Math.max(...vel).toFixed(3)] : null,
    hands: { L: run.res.notes.filter((n) => n.hand === 'L').length, R: run.res.notes.filter((n) => n.hand === 'R').length },
    tempoBpm: +run.res.tempo.bpm.toFixed(1),
    key: run.res.key?.name ?? null,
    onset: score(ref, est, lo, hi),
    onsetOffset: score(ref, est, lo, hi, true),
  };
}

/** The demo prelude rendered through the app's own piano engine (hall reverb), first `seconds`. */
async function runSynthetic(seconds = 20, engines: Engine[] = ['specialist', 'basic-pitch']) {
  const src = bachPreludeDemo();
  const end = Math.min(src.duration, seconds);
  const notes = src.notes.filter((n) => n.start < end - 0.3);
  const audio = await renderOffline({
    notes,
    pedal: src.pedal.filter((p) => p.start < end),
    settings: { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'hall' },
    start: 0,
    end,
    rate: 1,
    sampleRate: 44100,
  });
  const wav = new WavWriter(44100);
  wav.append(audio);
  const blob = wav.finish();
  // (the rendered note sounds until its key is released or the pedal lifts; offsets are not scored here)
  const ref = notes.map((n) => ({ midi: n.midi, start: n.start, end: n.start + n.dur }));
  const out = [];
  for (const e of engines) out.push(summary(e, await transcribe(blob, e), ref, 0.2, end - 0.5));
  return { kind: 'synthetic', seconds: end, refNotes: ref.length, runs: out };
}

/**
 * A MAESTRO excerpt: `url` = the recording (served by the runner), `ref` = its performance MIDI
 * notes (pedal-extended offsets, seconds from the start of the recording), cut to [start, start+dur].
 */
async function runExcerpt(url: string, ref: RefNote[], start: number, dur: number, engines: Engine[] = ['specialist', 'basic-pitch']) {
  const full = await decodeToRate(await (await fetch(url)).blob(), 44100);
  const from = Math.floor(start * 44100);
  const to = Math.min(full.length, Math.floor((start + dur) * 44100));
  const wav = new WavWriter(44100);
  wav.append(full, from, to);
  const blob = wav.finish();
  const len = (to - from) / 44100;
  const local = ref.map((n) => ({ midi: n.midi, start: n.start - start, end: n.end - start }));
  const out = [];
  for (const e of engines) out.push(summary(e, await transcribe(blob, e), local, 0.3, len - 0.5));
  return { kind: 'maestro-excerpt', start, seconds: +len.toFixed(2), refNotes: local.filter((n) => n.start >= 0.3 && n.start <= len - 0.5).length, runs: out };
}

/** Cancel while the model is analysing: the run must reject with AbortError, promptly. */
async function runAbort(seconds = 20) {
  const src = bachPreludeDemo();
  const end = Math.min(src.duration, seconds);
  const audio = await renderOffline({ notes: src.notes.filter((n) => n.start < end), pedal: [], settings: DEFAULT_AUDIO_SETTINGS, start: 0, end, rate: 1, sampleRate: 44100 });
  const wav = new WavWriter(44100);
  wav.append(audio);
  const ac = new AbortController();
  let abortedAt = 0;
  const t0 = performance.now();
  try {
    await transcribeAudio(
      wav.finish(),
      EXTRACTION_PRESETS.piano,
      (e) => {
        if (e.stage === 'analyzing' && !abortedAt) {
          abortedAt = performance.now();
          ac.abort();
        }
      },
      ac.signal,
      { engine: 'piano-specialist' },
    );
    return { rejected: false, abortedDuringAnalysis: !!abortedAt, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return {
      rejected: true,
      name: (err as Error).name,
      abortedDuringAnalysis: !!abortedAt,
      rejectAfterAbortMs: abortedAt ? Math.round(performance.now() - abortedAt) : null,
    };
  }
}

async function support() {
  const { pianoSpecialistSupport } = await import('../../src/lib/pianoSpecialist');
  return pianoSpecialistSupport();
}

Object.assign(window, { runSynthetic, runExcerpt, runAbort, support });
document.getElementById('log')!.textContent = 'ready';
