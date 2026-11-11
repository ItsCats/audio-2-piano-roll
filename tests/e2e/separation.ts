// Dev-only page used by tests/e2e/separation.mjs: runs the app's real in-browser SCNet separation
// (src/lib/separation) on an audio URL (optionally an excerpt), uploads the stems to the runner
// (which writes them OUTSIDE the repo) and returns timing, presence and alignment checks.
import { separateStems, separationSupport } from '../../src/lib/separation';
import { decimate2 } from '../../src/lib/separation/dsp';
import { decodeToRate, mixToMono } from '../../src/lib/transcription/decode';

const log = (m: string) => (document.getElementById('log')!.textContent = m);

/** 32-bit float stereo WAV, so the excerpt decodes back bit-exactly */
function wavF32(left: Float32Array, right: Float32Array, sr: number): Blob {
  const n = left.length;
  const buf = new ArrayBuffer(44 + n * 8);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 8, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 8, true);
  v.setUint16(32, 8, true);
  v.setUint16(34, 32, true);
  str(36, 'data');
  v.setUint32(40, n * 8, true);
  const f = new Float32Array(buf, 44);
  for (let i = 0; i < n; i++) {
    f[2 * i] = left[i];
    f[2 * i + 1] = right[i];
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function upload(name: string, data: Float32Array) {
  const r = await fetch(`/__sepout/${encodeURIComponent(name)}`, { method: 'POST', body: data.slice().buffer });
  if (!r.ok) throw new Error(`upload ${name}: ${r.status}`);
}

/** best lag of b against a (in samples, |lag| <= 8) and the SDR of b vs a at that lag */
function alignment(a: Float32Array, b: Float32Array) {
  const n = Math.min(a.length, b.length);
  let best = -Infinity;
  let lag = 0;
  for (let L = -8; L <= 8; L++) {
    let s = 0;
    for (let j = 1000; j < n - 1000; j++) s += a[j] * b[j + L];
    if (s > best) {
      best = s;
      lag = L;
    }
  }
  let num = 0;
  let den = 0;
  for (let j = 1000; j < n - 1000; j++) {
    num += a[j] * a[j];
    den += (a[j] - b[j]) ** 2;
  }
  return { lag, sdrDb: +(10 * Math.log10(num / den)).toFixed(1) };
}

async function separateUrl(url: string, tag: string, start = 0, dur = 0) {
  const t0 = performance.now();
  let blob = await (await fetch(url)).blob();
  if (dur > 0) {
    const full = await decodeToRate(blob, 44100);
    const a = Math.round(start * 44100);
    const b = Math.min(full.length, a + Math.round(dur * 44100));
    const left = full.getChannelData(0).slice(a, b);
    const right = full.numberOfChannels > 1 ? full.getChannelData(1).slice(a, b) : left.slice();
    blob = wavF32(left, right, 44100);
    await upload(`${tag}.input44.L.f32`, left);
    await upload(`${tag}.input44.R.f32`, right);
  }
  const prepMs = performance.now() - t0;
  const progress: Array<[number, number, string]> = [];
  const t1 = performance.now();
  const res = await separateStems(blob, (f, d) => {
    progress.push([Math.round(performance.now() - t1), +f.toFixed(4), d ?? '']);
    (window as unknown as { lastProgress: unknown }).lastProgress = [f, d];
  });
  const sepMs = performance.now() - t1;
  // timebase check: the app's 22.05 kHz decode of the same blob vs our 44.1k → 22.05k decimation
  const mix22 = mixToMono(await decodeToRate(blob, 22050));
  const mix44 = mixToMono(await decodeToRate(blob, 44100));
  const dec = decimate2(mix44);
  const align = alignment(mix22, dec);
  // stems sum vs mixture (drums missing, so only a loose check): lag of (vocals + accomp) vs the mix
  const sum = new Float32Array(res.vocals.length);
  for (let i = 0; i < sum.length; i++) sum[i] = res.vocals[i] + res.accomp[i];
  const stemLag = alignment(mix22, sum).lag;
  await upload(`${tag}.vocals22.f32`, res.vocals);
  await upload(`${tag}.accomp22.f32`, res.accomp);
  await upload(`${tag}.mix22.f32`, mix22);
  return {
    tag,
    seconds: mix44.length / 44100,
    len22: res.vocals.length,
    lenDecode22: mix22.length,
    lenAccomp22: res.accomp.length,
    sampleRate: res.sampleRate,
    engine: res.engine,
    vocalPresence: res.vocalPresence,
    ms: Math.round(res.ms),
    sepMs: Math.round(sepMs),
    prepMs: Math.round(prepMs),
    decimateVsDecode22: align,
    stemSumLag: stemLag,
    progress: progress.filter((p, i) => i === 0 || i === progress.length - 1 || !p[2].startsWith('Downloading') || i % 20 === 0),
    support: separationSupport(),
    crossOriginIsolated: self.crossOriginIsolated,
  };
}

async function cancelTest(url: string) {
  const blob = await (await fetch(url)).blob();
  const ac = new AbortController();
  const t0 = performance.now();
  let firstSegmentAt = 0;
  const p = separateStems(blob, (f) => {
    if (f >= 0.08 && !firstSegmentAt) {
      firstSegmentAt = performance.now() - t0;
      setTimeout(() => ac.abort(), 2000);
    }
  }, ac.signal);
  try {
    await p;
    return { aborted: false };
  } catch (e) {
    return { aborted: (e as DOMException).name === 'AbortError', afterMs: Math.round(performance.now() - t0), firstSegmentAt: Math.round(firstSegmentAt) };
  }
}

Object.assign(window, { separateUrl, cancelTest });
log('ready');
