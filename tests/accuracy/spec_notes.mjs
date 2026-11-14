/**
 * The piano model's notes of separated "other" stems, for the accuracy harness's --specialist-notes cache
 * (tests/accuracy/transcribe.mjs --presets mix-blend) and offline tuning of music/pianoBlend.ts: made in
 * Playwright Chromium exactly as "Full song + piano model" makes them in an import (tests/e2e/specnotes.ts).
 *
 *   node tests/accuracy/spec_notes.mjs --out DIR [--port 5302] [--force] stem1.other.s16 [song2.wav ...]
 *
 * Inputs: raw mono 16-bit PCM at 22.05 kHz (`.s16`, the dump harness's <id>.other.s16) or audio files.
 * Writes DIR/<id>.spec.f32 (<id> = the file name up to its first dot; 6 float32 per note: start, dur,
 * midi, velocity, onset peak, frame mean). Cross-origin isolated (WASM threads), a fresh tab per file,
 * one model run at a time (a heavy job). Existing outputs are skipped unless --force.
 * ACC_VITE_CACHE=DIR uses a private Vite dependency cache.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
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
const outDir = opt('out', null);
const port = +opt('port', '5302');
const force = flag('force');
const files = args;
if (!outDir || !files.length) {
  console.error('usage: node tests/accuracy/spec_notes.mjs --out DIR [--port N] [--force] files...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const serveFiles = {
  name: 'spec-notes-audio',
  configureServer(srv) {
    srv.middlewares.use('/__specaudio', (req, res) => {
      const file = files[+decodeURIComponent(req.url.replace(/^\//, ''))];
      if (!file) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    });
  },
};
const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  plugins: [serveFiles],
  server: { port, strictPort: true },
  logLevel: 'error',
  ...(process.env.ACC_VITE_CACHE ? { cacheDir: path.resolve(process.env.ACC_VITE_CACHE) } : {}),
});
await server.listen();
const { chromium } = await import('playwright');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0;
try {
  for (let i = 0; i < files.length; i++) {
    const id = path.basename(files[i]).split('.')[0];
    const out = path.join(outDir, `${id}.spec.f32`);
    if (!force && fs.existsSync(out)) {
      console.log(`skip ${id}`);
      continue;
    }
    // a dev-server dependency re-optimization reloads the page (up to twice with a fresh cache): retried
    for (let attempt = 0; ; attempt++) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.error('[pageerror]', e.message));
      page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
      try {
        await page.goto(`http://localhost:${port}/tests/e2e/specnotes.html?coi=1`);
        await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
        const r = await page.evaluate(([u, raw]) => window.specNotes(u, raw), [`http://localhost:${port}/__specaudio/${i}`, files[i].endsWith('.s16')]);
        fs.writeFileSync(out, Buffer.from(new Float32Array(r.packed).buffer));
        console.log(`${id.padEnd(24)} ${r.n} notes, ${r.duration.toFixed(0)} s audio, piano model ${(r.ms / 1000).toFixed(1)} s`);
        break;
      } catch (err) {
        const reload = /context was destroyed|navigation/i.test(err.message);
        console.error(`${reload && attempt < 2 ? 'RETRY (page reloaded)' : 'FAILED'} ${id}: ${err.message}`);
        if (!reload || attempt >= 2) {
          failed++;
          break;
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
