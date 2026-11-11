/**
 * Headless transcription runner: runs the app's REAL in-browser pipeline (decode → Basic Pitch
 * in a Web Worker → extraction → cleanup → hands → beats → key) plus the Easy/Medium/Hard
 * arrangement generator on local audio files, in Playwright Chromium.
 *
 *   node tests/accuracy/transcribe.mjs --out DIR [--port 5302] [--presets piano,mix] [--posteriors] song1.mp3 [song2.mp3 ...]
 *   node tests/accuracy/transcribe.mjs --dump-posteriors DIR [--port 5302] song1.wav [...]
 *
 * Writes DIR/<basename>.<preset>.json.
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
const force = flag('force');
const songs = args;
if (!outDir || !songs.length) {
  console.error('usage: node tests/accuracy/transcribe.mjs --out DIR [--port N] [--presets piano,mix] [--posteriors] [--force] files...');
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
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), plugins: [serveAudio], server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  let page;
  const openPage = async () => {
    page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
    page.on('crash', () => console.error('[crash] page crashed'));
    await page.goto(`http://localhost:${port}/tests/e2e/accuracy.html`);
    await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  };
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
      const t0 = Date.now();
      const loadBefore = os.loadavg()[0];
      let r;
      try {
        r = await page.evaluate(
          ([u, p, w]) => window.transcribeUrl(u, p, w),
          [`http://localhost:${port}/__accaudio/${i}`, preset, withPosteriors],
        );
      } catch (err) {
        console.error(`FAILED ${name} ${preset}: ${err.message}`);
        await page.close().catch(() => {});
        await openPage();
        continue;
      }
      r.song = name;
      r.file = path.resolve(songs[i]);
      r.wallMs = Date.now() - t0;
      r.host = { cpus: os.cpus().length, loadavg1Before: +loadBefore.toFixed(2), loadavg1After: +os.loadavg()[0].toFixed(2) };
      fs.writeFileSync(out, JSON.stringify(r));
      console.log(
        `${name.padEnd(24)} ${preset.padEnd(9)} ${r.base.length} notes (E ${r.easy.length} / M ${r.medium.length}) ` +
          `${(r.timing.transcribeMs / 1000).toFixed(1)}s for ${r.duration.toFixed(0)}s audio, ${r.info.backend}, ${r.tempo.bpm.toFixed(1)} BPM, ${r.key?.name}`,
      );
    }
  }
} finally {
  await browser.close();
  await server.close();
}
