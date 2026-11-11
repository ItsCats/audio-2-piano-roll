// Dev-only page used by `node tests/e2e/isolation.mjs bench`: times the app's real SCNet separation
// (src/lib/separation, fresh worker per run) on an audio URL. Open with ?coi=1 to get the app's
// cross-origin isolation headers (vite.config.ts), i.e. the multi-threaded path; without it the
// page is not isolated and the worker runs one thread.
import { separateStereo44k } from '../../src/lib/separation';
import { decodeToRate } from '../../src/lib/transcription/decode';

const log = (m: string) => (document.getElementById('log')!.textContent = m);

async function bench(url: string) {
  const blob = await (await fetch(url)).blob();
  const buf = await decodeToRate(blob, 44100);
  const left = buf.getChannelData(0).slice();
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : left.slice();
  const seconds = left.length / 44100;
  let segments = 0;
  const t0 = performance.now();
  const raw = await separateStereo44k(left, right, (_f, d) => {
    const m = d?.match(/part (\d+) of (\d+)/);
    if (m) segments = +m[2];
  });
  const ms = performance.now() - t0;
  return {
    seconds: +seconds.toFixed(2),
    segments,
    ms: Math.round(ms),
    separateMs: Math.round(raw.stats.separateMs),
    secondsPerMinute: +((ms / 1000 / seconds) * 60).toFixed(1),
    modelSecondsPerMinute: +((raw.stats.separateMs / 1000 / seconds) * 60).toFixed(1),
    threads: raw.stats.threads,
    fromCache: raw.stats.fromCache,
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}

Object.assign(window, { bench });
log('ready');
