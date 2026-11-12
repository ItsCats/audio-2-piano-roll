// Dev-only page used by tests/accuracy/transcribe.mjs: runs the app's real transcription
// pipeline + arrangement generator on an audio URL and returns plain JSON.
// Preset 'specialist' = the high-accuracy piano model engine (TranscribeOptions.engine
// 'piano-specialist': the ByteDance piano model in its own worker; Basic Pitch's detection
// parameters do not apply, so `params` is null and there are no posteriors).
import { transcribeAudio, EXTRACTION_PRESETS } from '../../src/lib/transcription/pipeline';
import { generateAllArrangements } from '../../src/lib/music/difficulty';
import type { Note } from '../../src/lib/music/types';

type Preset = keyof typeof EXTRACTION_PRESETS | 'specialist';

const slim = (notes: Note[]) =>
  notes.map((n) => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), vel: +n.vel.toFixed(3), hand: n.hand, ...(n.role ? { role: n.role } : {}) }));

function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function transcribeUrl(url: string, preset: Preset, withPosteriors = false, separate = false) {
  const t0 = performance.now();
  const blob = await (await fetch(url)).blob();
  const fetchMs = performance.now() - t0;
  const stageTimes: Record<string, number> = {};
  let last = performance.now();
  let lastStage = '';
  const specialist = preset === 'specialist';
  const params = specialist ? EXTRACTION_PRESETS.piano : EXTRACTION_PRESETS[preset];
  const t1 = performance.now();
  const res = await transcribeAudio(
    blob,
    params,
    (e) => {
      if (e.stage !== lastStage) {
        const now = performance.now();
        if (lastStage) stageTimes[lastStage] = (stageTimes[lastStage] ?? 0) + now - last;
        last = now;
        lastStage = e.stage;
      }
    },
    undefined,
    specialist ? { engine: 'piano-specialist' } : { separate },
  );
  const transcribeMs = performance.now() - t1;
  if (lastStage) stageTimes[lastStage] = (stageTimes[lastStage] ?? 0) + performance.now() - last;
  const t2 = performance.now();
  const arr = generateAllArrangements(res.notes, [], res.tempo, res.duration);
  const arrangeMs = performance.now() - t2;
  return {
    preset,
    engine: specialist ? 'piano-specialist' : 'basic-pitch',
    separate: specialist ? false : separate,
    params: specialist ? null : params,
    duration: res.duration,
    tempo: { bpm: res.tempo.bpm, confidence: res.tempo.confidence, beatsPerBar: res.tempo.beatsPerBar, downbeatIndex: res.tempo.downbeatIndex, beats: res.tempo.beats.map((b) => +b.toFixed(4)) },
    key: res.key ?? null,
    info: { ...res.info, params: undefined },
    timing: {
      fetchMs: Math.round(fetchMs),
      transcribeMs: Math.round(transcribeMs),
      pipelineProcessingMs: res.info.processingMs,
      arrangeMs: Math.round(arrangeMs),
      stagesMs: Object.fromEntries(Object.entries(stageTimes).map(([k, v]) => [k, Math.round(v)])),
    },
    base: slim(res.notes),
    easy: slim(arr.easy.notes),
    medium: slim(arr.medium.notes),
    hard: slim(arr.hard.notes),
    posteriors: withPosteriors && res.posteriors
      ? { nFrames: res.posteriors.nFrames, frames: toB64(res.posteriors.frames), onsets: toB64(res.posteriors.onsets) }
      : undefined,
  };
}

Object.assign(window, { transcribeUrl });
document.getElementById('log')!.textContent = 'ready';
