// Dev-only page for tests/accuracy/spec_notes.mjs: the piano model's notes of a separated "other" stem,
// made exactly as "Full song + piano model" makes them in an import (transcription/pipeline.ts: the
// 22.05 kHz stem → decode.ts resampleTo 16 kHz → the piano model → music/pianoBlend.ts
// specNotesFromOutputs), packed (packSpecNotes) for the accuracy harness's --specialist-notes cache.
// Input: raw mono 16-bit PCM at 22.05 kHz (the dump harness's <id>.other.s16) or any audio file
// (decoded to 22.05 kHz mono).
import { runPianoSpecialist } from '../../src/lib/pianoSpecialist';
import { packSpecNotes, specNotesFromOutputs } from '../../src/lib/music/pianoBlend';
import { decodeToRate, mixToMono, resampleTo } from '../../src/lib/transcription/decode';
import { BP_SAMPLE_RATE } from '../../src/lib/transcription/constants';
import { SPECIALIST_SAMPLE_RATE } from '../../src/lib/transcription/pipeline';

async function specNotes(url: string, raw: boolean) {
  const res = await fetch(url);
  let stem: Float32Array;
  if (raw) {
    const s16 = new Int16Array(await res.arrayBuffer());
    stem = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) stem[i] = s16[i] / 32767;
  } else {
    stem = mixToMono(await decodeToRate(await res.blob(), BP_SAMPLE_RATE));
  }
  const duration = stem.length / BP_SAMPLE_RATE;
  const t0 = performance.now();
  const run = await runPianoSpecialist(resampleTo(stem, BP_SAMPLE_RATE, SPECIALIST_SAMPLE_RATE), undefined, undefined, { release: true, transfer: true });
  const notes = specNotesFromOutputs(run, duration);
  return { duration, ms: Math.round(performance.now() - t0), n: notes.length, packed: Array.from(packSpecNotes(notes)) };
}

Object.assign(window, { specNotes });
document.getElementById('log')!.textContent = 'ready';
