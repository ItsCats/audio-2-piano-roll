/**
 * Headless transcription runner: runs the app's REAL in-browser pipeline (decode → Basic Pitch
 * in a Web Worker → extraction → cleanup → hands → beats → key) plus the Easy/Medium/Hard
 * arrangement generator on local audio files, in Playwright Chromium.
 *
 *   node tests/accuracy/transcribe.mjs --out DIR [--port 5302] [--presets piano,mix] [--posteriors] [--separate] song1.mp3 [song2.mp3 ...]
 *   node tests/accuracy/transcribe.mjs --dump-posteriors DIR [--port 5302] song1.wav [...]
 *
 * Writes DIR/<basename>.<preset>.json.
 *
 * --separate runs the shipped separated path (transcribeAudio(..., { separate: true }): in-browser
 * SCNet, accompaniment + vocal melody). It needs ~2.5 GB per run and ~2 min per minute of audio
 * single-threaded (the harness page is not cross-origin isolated); run one at a time.
 *
 * --coi opens the harness page cross-origin isolated (?coi=1, like the shipped app routes), so the
 * separation worker can use WASM threads (the app's real desktop speed). Without it the page is
 * single-threaded.
 *
 * Every run records the browser's peak memory while it ran (`memory`: sampled every 0.5 s from
 * /proc over the Chromium process tree: peak resident size of the largest process = the tab's
 * renderer with its workers, and the peak summed PSS of the whole tree). With --separate each run
 * gets a fresh tab so the peaks are per song.
 *
 * --presets specialist runs the high-accuracy piano model engine instead of Basic Pitch
 * (TranscribeOptions.engine 'piano-specialist': the ByteDance piano model, ONNX in a WASM worker) and
 * writes DIR/<basename>.specialist.json in the same format (no posteriors; `params` is null). Each
 * specialist run gets a fresh tab (per-song memory peaks; the model file stays in the browser's HTTP
 * cache, so only the first run downloads it — see timing.stagesMs['loading-model']). Use --coi for
 * the desktop speed (WASM threads); one run at a time.
 *
 * --timeout-min N (default 30) gives up on a run after N minutes (the tab is closed, which stops its
 * workers) and goes on with the next one.
 *
 * ACC_VITE_CACHE=DIR uses a private Vite dependency cache (node_modules is shared between checkouts).
 *
 * --override '{"piano":{...}}' merges partial ExtractionParams into the app's EXTRACTION_PRESETS
 * in the page before transcribing (candidate presets through the full browser path).
 *
 * --dump-posteriors DIR runs the model once per file (the posteriors do not depend on the detection
 * preset) and saves exactly what the app stores for re-detection: DIR/<basename>.frames.u8 and
 * .onsets.u8 (nFrames x 88, 8-bit quantised, row-major), .rms.f32 (100 fps loudness envelope) and
 * .post.json (nFrames, duration, plus the 'piano' and 'sensitive' base notes of the same run, so a
 * node-side re-extraction can be checked against the browser). Keep DIR outside the repo
 * (tests/accuracy/sweep_extraction.ts reads it). Files are served to the page through a Playwright route
 * (they are never copied into the repo). Existing outputs are skipped unless --force.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const dumpDir = opt('dump-posteriors', null);
const outDir = opt('out', dumpDir);
const port = +opt('port', '5302');
const presets = opt('presets', 'piano,mix').split(',');
const withPosteriors = flag('posteriors');
const separate = flag('separate');
const override = JSON.parse(opt('override', 'null'));
const force = flag('force');
const coi = flag('coi');
const timeoutMs = +opt('timeout-min', '30') * 60000;
const songs = args;
if (!outDir || !songs.length) {
  console.error('usage: node tests/accuracy/transcribe.mjs --out DIR [--port N] [--presets piano,mix] [--posteriors] [--separate] [--coi] [--force] files...');
  console.error('       node tests/accuracy/transcribe.mjs --dump-posteriors DIR [--port N] [--force] files...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const { chromium } = await import('playwright');
const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
// Serve the audio files straight from disk (streamed) through a dev-server middleware: large files
// would not survive a Playwright route (the body is base64-encoded over CDP).
const serveAudio = {
  name: 'accuracy-audio',
  configureServer(srv) {
    srv.middlewares.use('/__accaudio', (req, res) => {
      const file = songs[+decodeURIComponent(req.url.replace(/^\//, ''))];
      if (!file) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    });
  },
};
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  plugins: [serveAudio],
  server: { port, strictPort: true },
  logLevel: 'error',
  ...(process.env.ACC_VITE_CACHE ? { cacheDir: path.resolve(process.env.ACC_VITE_CACHE) } : {}),
});
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let sampler;
try {
  let page;
  const openPage = async () => {
    page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
    page.on('crash', () => console.error('[crash] page crashed'));
    await page.goto(`http://localhost:${port}/tests/e2e/accuracy.html${coi ? '?coi=1' : ''}`);
    await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
    if (override) {
      await page.evaluate(async (o) => {
        const { EXTRACTION_PRESETS } = await import('/src/lib/transcription/pipeline.ts');
        for (const [k, v] of Object.entries(o)) Object.assign(EXTRACTION_PRESETS[k], v);
      }, override);
    }
  };
  // ---- browser memory sampler (Linux /proc): the Chromium processes this script launched
  const treePids = () => {
    const kids = new Map();
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(+d);
      } catch {}
    }
    const out = [];
    const stack = [...(kids.get(process.pid) ?? [])];
    while (stack.length) {
      const p = stack.pop();
      stack.push(...(kids.get(p) ?? []));
      try {
        if (/chrom|headless_shell/i.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'))) out.push(p);
      } catch {}
    }
    return out;
  };
  const kb = (txt, key) => {
    const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? +m[1] : 0;
  };
  let mem = null;
  const sample = () => {
    if (!mem) return;
    let pss = 0;
    let rss = 0;
    let maxProc = 0;
    for (const p of treePids()) {
      try {
        const r = kb(fs.readFileSync(`/proc/${p}/status`, 'utf8'), 'VmRSS');
        rss += r;
        maxProc = Math.max(maxProc, r);
        pss += kb(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'), 'Pss');
      } catch {}
    }
    mem.peakProcRssMB = Math.max(mem.peakProcRssMB, Math.round(maxProc / 1024));
    mem.peakTreeRssMB = Math.max(mem.peakTreeRssMB, Math.round(rss / 1024));
    mem.peakTreePssMB = Math.max(mem.peakTreePssMB, Math.round(pss / 1024));
    mem.samples++;
  };
  sampler = setInterval(sample, 500);
  await openPage();
  if (dumpDir) {
    for (let i = 0; i < songs.length; i++) {
      const name = path.basename(songs[i]).replace(/\.[^.]+$/, '');
      const meta = path.join(dumpDir, `${name}.post.json`);
      if (!force && fs.existsSync(meta)) {
        console.log(`skip ${name}`);
        continue;
      }
      const t0 = Date.now();
      const r = await page.evaluate(async (u) => {
        // the app's own modules, served by the Vite dev server
        const { transcribeAudio, reextractNotes, EXTRACTION_PRESETS } = await import('/src/lib/transcription/pipeline.ts');
        const b64 = (u8) => {
          let s = '';
          for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          return btoa(s);
        };
        const slim = (ns) => ns.map((n) => ({ midi: n.midi, start: n.start, dur: n.dur, vel: n.vel }));
        const blob = await (await fetch(u)).blob();
        const res = await transcribeAudio(blob, EXTRACTION_PRESETS.piano, () => {});
        const p = res.posteriors;
        // re-detection on the stored (quantised) posteriors, exactly what the app does on a preset change
        const piano = await reextractNotes(p, EXTRACTION_PRESETS.piano, res.duration);
        const sensitive = await reextractNotes(p, EXTRACTION_PRESETS.sensitive, res.duration);
        return {
          nFrames: p.nFrames,
          duration: res.duration,
          backend: res.info.backend,
          frames: b64(p.frames),
          onsets: b64(p.onsets),
          rms: b64(new Uint8Array(p.rms.buffer, p.rms.byteOffset, p.rms.byteLength)),
          notes: { pianoFirstPass: slim(res.notes), piano: slim(piano), sensitive: slim(sensitive) },
        };
      }, `http://localhost:${port}/__accaudio/${i}`);
      fs.writeFileSync(path.join(dumpDir, `${name}.frames.u8`), Buffer.from(r.frames, 'base64'));
      fs.writeFileSync(path.join(dumpDir, `${name}.onsets.u8`), Buffer.from(r.onsets, 'base64'));
      fs.writeFileSync(path.join(dumpDir, `${name}.rms.f32`), Buffer.from(r.rms, 'base64'));
      fs.writeFileSync(
        meta,
        JSON.stringify({ song: name, file: path.resolve(songs[i]), nFrames: r.nFrames, duration: r.duration, backend: r.backend, wallMs: Date.now() - t0, notes: r.notes }),
      );
      console.log(`${name.padEnd(24)} ${r.nFrames} frames, ${r.duration.toFixed(0)} s, ${r.backend}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    songs.length = 0;
  }
  for (let i = 0; i < songs.length; i++) {
    const name = path.basename(songs[i]).replace(/\.[^.]+$/, '');
    for (const preset of presets) {
      const out = path.join(outDir, `${name}.${preset}.json`);
      if (!force && fs.existsSync(out)) {
        console.log(`skip ${name} ${preset}`);
        continue;
      }
      if (separate || preset === 'specialist') {
        // a fresh tab per separated / specialist run: per-song memory peaks, no heap carried over
        await page.close().catch(() => {});
        await openPage();
      }
      const t0 = Date.now();
      const loadBefore = os.loadavg()[0];
      mem = { peakProcRssMB: 0, peakTreeRssMB: 0, peakTreePssMB: 0, samples: 0 };
      sample();
      let r;
      let failed = false;
      for (let attempt = 0; ; attempt++) {
        try {
          let timer;
          r = await Promise.race([
            page.evaluate(
              ([u, p, w, s]) => window.transcribeUrl(u, p, w, s),
              [`http://localhost:${port}/__accaudio/${i}`, preset, withPosteriors, separate],
            ),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 60000} min`)), timeoutMs);
            }),
          ]).finally(() => clearTimeout(timer));
          break;
        } catch (err) {
          // a dev-server dependency re-optimisation reloads the page (up to twice with a fresh cache: the
          // page's and then the worker's dependencies): retry that, nothing else
          const reload = /context was destroyed|navigation/i.test(err.message);
          console.error(`${reload && attempt < 2 ? 'RETRY (page reloaded)' : 'FAILED'} ${name} ${preset}: ${err.message}`);
          await page.close().catch(() => {});
          await openPage();
          if (reload && attempt < 2) {
            mem = { peakProcRssMB: 0, peakTreeRssMB: 0, peakTreePssMB: 0, samples: 0 };
            continue;
          }
          failed = true;
          break;
        }
      }
      if (failed) {
        mem = null;
        continue;
      }
      sample();
      r.memory = mem;
      mem = null;
      r.coi = coi;
      r.song = name;
      r.file = path.resolve(songs[i]);
      r.wallMs = Date.now() - t0;
      r.host = { cpus: os.cpus().length, loadavg1Before: +loadBefore.toFixed(2), loadavg1After: +os.loadavg()[0].toFixed(2) };
      fs.writeFileSync(out, JSON.stringify(r));
      console.log(
        `${name.padEnd(24)} ${preset.padEnd(10)} ${r.base.length} notes (E ${r.easy.length} / M ${r.medium.length}) ` +
          `${(r.timing.transcribeMs / 1000).toFixed(1)}s for ${r.duration.toFixed(0)}s audio, ${r.info.backend}, ${r.tempo.bpm.toFixed(1)} BPM, ${r.key?.name}, ` +
          `peak ${r.memory.peakProcRssMB} MB (tab), ${r.memory.peakTreePssMB} MB PSS (all)`,
      );
    }
  }
} finally {
  clearInterval(sampler);
  await browser.close();
  await server.close();
}
