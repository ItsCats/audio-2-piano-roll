// Dev-only page for tests/accuracy/pti_export_browser.mjs: runs the app's piano-specialist worker
// (src/lib/pianoSpecialist) on the exact 16 kHz input pti_export_check.py wrote, and compares its four
// output maps with the Python ones (PyTorch float32 and onnxruntime CPU on the same ONNX file).
import { runPianoSpecialist, type SpecialistProgress } from '../../src/lib/pianoSpecialist';
import { PTI_OUTPUTS } from '../../src/lib/pianoSpecialist/protocol';

const THRESH: Record<string, number> = { frame: 0.1, onset: 0.3, offset: 0.3 };

async function f32(url: string): Promise<Float32Array | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  return new Float32Array(await r.arrayBuffer());
}

function compare(a: Float32Array, b: Float32Array, th?: number) {
  if (a.length !== b.length) return { lengthMismatch: [a.length, b.length] };
  let max = 0;
  let sum = 0;
  let agree = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    sum += d;
    if (th !== undefined && a[i] > th === b[i] > th) agree++;
  }
  return { maxAbsDiff: max, meanAbsDiff: sum / a.length, ...(th !== undefined ? { thresholdedAgreement: agree / a.length } : {}) };
}

declare global {
  interface Window {
    runParity: (id: string, threads: number, save: boolean) => Promise<unknown>;
  }
}

window.runParity = async (id, threads, save) => {
  const audio = await f32(`/__pti/${encodeURIComponent(id)}.audio16k.f32`);
  if (!audio) throw new Error(`no audio for ${id}`);
  const progress: SpecialistProgress[] = [];
  const t0 = performance.now();
  const r = await runPianoSpecialist(audio, (e) => progress.push(e), undefined, { threads, release: true });
  const wallMs = performance.now() - t0;
  const out: Record<string, unknown> = {
    id,
    seconds: audio.length / 16000,
    nFrames: r.nFrames,
    threads: r.threads,
    crossOriginIsolated: self.crossOriginIsolated,
    wallMs: Math.round(wallMs),
    stats: r.stats,
    secondsPerMinute: +((r.stats.inferMs / 1000 / (audio.length / 16000)) * 60).toFixed(1),
    progressEvents: progress.length,
    lastProgress: progress[progress.length - 1],
  };
  for (const ref of ['torch', 'onnx']) {
    const cmp: Record<string, unknown> = {};
    for (const k of PTI_OUTPUTS) {
      const b = await f32(`/__pti/${encodeURIComponent(id)}.${ref}.${k}.f32`);
      if (b) cmp[k] = compare(r[k], b, THRESH[k]);
    }
    out[`vs_${ref}`] = cmp;
  }
  if (save) {
    for (const k of PTI_OUTPUTS) {
      await fetch(`/__ptiout/${encodeURIComponent(`${id}.browser${threads}.${k}.f32`)}`, { method: 'POST', body: r[k] });
    }
  }
  return out;
};
document.getElementById('log')!.textContent = 'ready';
