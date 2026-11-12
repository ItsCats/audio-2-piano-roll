// CREPE-tiny vocal pitch tracking vs the current Basic Pitch vocal path, in headless Chromium
// (the app's real code: src/lib/pitch and src/lib/transcription, WASM only).
//
//   node tests/accuracy/crepe_track.mjs --out WORK/crepe [--hop 10] [--no-bp] [--no-crepe] [--coi] [--opts '{"voicingThreshold":0.5}'] ID=VOCALS.wav ...
//
// For every vocal stem (mono-mixed and decoded at 22.05 kHz exactly as the app does) it writes
// OUT/<ID>.crepe.json with
//   crepe: f0 (voiced, Hz), rawF0, periodicity, rms (base64 float32, one per hop), notes (candidates),
//          line (src/lib/pitch/line.ts crepeMelodyLine), lineMelodyTs (melody.ts extractMelodyLine, speech off),
//          stats (ms), rss (browser process tree, MB)
//   bp:    notes (cleanNotes of the vocal stem with VOCAL_EXTRACTION), line (melodyFromRaw = the
//          current app path), ms, peakRssMb
// Files are served to the page by path (never copied). Run one browser job at a time.
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (k) => {
  const i = args.indexOf(k);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const outDir = opt('--out', null);
const hop = Number(opt('--hop', '10'));
const extra = JSON.parse(opt('--opts', '{}'));
const noBp = flag('--no-bp');
const noCrepe = flag('--no-crepe');
// serve with COOP/COEP (cross-origin isolation) so onnxruntime-web may use WASM threads
const coi = flag('--coi');
if (!outDir || !args.length) {
  console.error('usage: node tests/accuracy/crepe_track.mjs --out DIR [--hop 10] [--no-bp] [--opts JSON] ID=FILE.wav ...');
  process.exit(2);
}
const jobs = args.map((a) => {
  const k = a.indexOf('=');
  return k > 0 ? { id: a.slice(0, k), file: path.resolve(a.slice(k + 1)) } : { id: path.basename(a).split('.')[0], file: path.resolve(a) };
});

const PAGE = `
import { trackVocalPitchDetailed } from '/src/lib/pitch/index.ts';
import { decodeToRate, mixToMono, analyzeLevel } from '/src/lib/transcription/decode.ts';
import { transcriber, toWorkerOptions, cleanNotes, melodyFromRaw, VOCAL_EXTRACTION } from '/src/lib/transcription/pipeline.ts';
import { extractMelodyLine } from '/src/lib/music/melody.ts';
import { crepeMelodyLine } from '/src/lib/pitch/line.ts';

const slim = (ns) => ns.map((n) => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), vel: +n.vel.toFixed(3), hand: n.hand, ...(n.role ? { role: n.role } : {}) }));
const b64 = (f) => { const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
async function load(url) {
  const buf = await decodeToRate(await (await fetch(url)).blob(), 22050);
  return { audio: mixToMono(buf), duration: buf.duration };
}
window.runCrepe = async (url, opts) => {
  const { audio, duration } = await load(url);
  const t0 = performance.now();
  const r = await trackVocalPitchDetailed(audio, () => {}, undefined, opts);
  const ms = performance.now() - t0;
  const line = crepeMelodyLine(r.notes);
  const lineMelodyTs = extractMelodyLine(r.notes, { speech: null });
  return { duration, ms, stats: r.stats, hop: r.hop, f0: b64(r.f0), rawF0: b64(r.rawF0), periodicity: b64(r.periodicity), rms: b64(r.rms), notes: slim(r.notes), line: slim(line), lineMelodyTs: slim(lineMelodyTs) };
};
window.runBp = async (url) => {
  const { audio, duration } = await load(url);
  const lv = analyzeLevel(audio);
  if (lv.peak > 1e-6) { const g = Math.min(8, 0.9 / lv.peak); if (g > 1.05) for (let i = 0; i < audio.length; i++) audio[i] *= g; }
  const t0 = performance.now();
  const modelUrl = new URL('/models/basic-pitch/model.json', location.href).href;
  const res = await transcriber.run({ type: 'transcribe', audio, modelUrl, options: toWorkerOptions(VOCAL_EXTRACTION) }, [audio.buffer], () => {}, undefined, 'transcribed');
  const ms = performance.now() - t0;
  const notes = cleanNotes(res.notes, res.rms, VOCAL_EXTRACTION, duration);
  const line = melodyFromRaw(res.notes, res.rms, duration);
  return { duration, ms, backend: res.backend, notes: slim(notes), line: slim(line), onsetFrames: res.notes.map((n) => [n.startFrame, n.midi, +n.onset.toFixed(3)]) };
};
document.getElementById('log').textContent = 'ready';
`;

const files = [];
const plugin = {
  name: 'crepe-harness',
  resolveId: (id) => (id === '/__crepe_page.js' ? '\0crepe-page.js' : null),
  load: (id) => (id === '\0crepe-page.js' ? PAGE : null),
  configureServer(srv) {
    if (coi) {
      srv.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    }
    srv.middlewares.use('/__file', (req, res) => {
      const f = files[Number(req.url.replace(/^\//, ''))];
      if (!f) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', 'audio/wav');
      res.setHeader('content-length', fs.statSync(f).size);
      fs.createReadStream(f).pipe(res);
    });
    srv.middlewares.use('/__crepe.html', async (req, res) => {
      const html = await srv.transformIndexHtml('/__crepe.html', '<!doctype html><html><body><pre id="log">x</pre><script type="module" src="/__crepe_page.js"></script></body></html>');
      res.setHeader('content-type', 'text/html');
      res.end(html);
    });
  },
};

/** RSS (MB) of a process and all its descendants. */
function treeRssMb(pid) {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    const rss = new Map(rows.map(([p, , r]) => [p, r]));
    let sum = 0;
    const stack = [pid];
    while (stack.length) {
      const p = stack.pop();
      sum += rss.get(p) ?? 0;
      stack.push(...(kids.get(p) ?? []));
    }
    return sum / 1024;
  } catch {
    return NaN;
  }
}

const browserRssMb = (pid) => treeRssMb(pid) - process.memoryUsage().rss / 2 ** 20;

async function withPeakRss(pid, fn) {
  const before = browserRssMb(pid);
  let peak = before;
  const timer = setInterval(() => (peak = Math.max(peak, browserRssMb(pid))), 200);
  try {
    const r = await fn();
    return { r, beforeMb: Math.round(before), peakMb: Math.round(peak), deltaMb: Math.round(peak - before) };
  } finally {
    clearInterval(timer);
  }
}

const port = 5420 + Math.floor(Math.random() * 60);
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  plugins: [plugin],
  cacheDir: path.join(outDir, '.vite'),
  server: { port, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const { chromium } = await import('playwright');
const browser = await chromium.launch();
fs.mkdirSync(outDir, { recursive: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.error('[console]', m.text()));
  await page.goto(`http://localhost:${port}/__crepe.html`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  // chromium is a child of this node process: measure the node process tree minus node itself
  const pid = process.pid;
  for (const job of jobs) {
    files.push(job.file);
    const url = `/__file/${files.length - 1}`;
    const out = { id: job.id, file: path.basename(job.file), hopMs: hop, opts: extra };
    if (!noCrepe) {
      const m = await withPeakRss(pid, () => page.evaluate(([u, o]) => window.runCrepe(u, o), [url, { hopMs: hop, ...extra }]));
      out.crepe = { ...m.r, rss: { beforeMb: m.beforeMb, peakMb: m.peakMb, deltaMb: m.deltaMb } };
      const s = m.r.stats;
      console.log(job.id, `crepe ${(m.r.ms / 1000).toFixed(1)}s for ${m.r.duration.toFixed(0)}s audio = ${((m.r.ms / 1000) * 60 / m.r.duration).toFixed(1)} s/min`,
        `(infer ${(s.inferMs / 1000).toFixed(1)}s, ${s.inferred}/${s.frames} frames, threads ${s.threads}) notes ${m.r.notes.length} line ${m.r.line.length}`,
        `rss +${m.deltaMb} MB (peak ${m.peakMb})`);
    }
    if (!noBp) {
      const m = await withPeakRss(pid, () => page.evaluate((u) => window.runBp(u), url));
      out.bp = { ...m.r, rss: { beforeMb: m.beforeMb, peakMb: m.peakMb, deltaMb: m.deltaMb } };
      console.log(job.id, `bp ${(m.r.ms / 1000).toFixed(1)}s = ${((m.r.ms / 1000) * 60 / m.r.duration).toFixed(1)} s/min (${m.r.backend}) notes ${m.r.notes.length} line ${m.r.line.length} rss +${m.deltaMb} MB`);
    }
    fs.writeFileSync(path.join(outDir, `${job.id}.crepe.json`), JSON.stringify(out));
  }
} finally {
  await browser.close();
  await server.close();
}
