/**
 * End-to-end check of the homr sheet-music reader (src/lib/omr/homr) in Playwright Chromium on the dev
 * server: a made-up piano piece (C major, 4/4, 12 bars, both hands, a few thirds) is engraved with the
 * app's notation library (OSMD) as a clean page, read with homr in its worker, and the MusicXML goes
 * through the normal score import (importMusicXml) and is scored note by note against the piece.
 * Fails if notes F1 < 0.95, if progress never reaches the end or goes backwards, or if cancelling does
 * not stop the job within 3 s. Also prints the time per page and the browser's peak memory.
 *
 *   node tests/e2e/homr.mjs [--port 5183] [--seed 7] [--threads 3,1] [--no-coi] [--png OUT.png] [--timeout-min 20]
 *
 * The first run downloads the model files from public/models/homr/ (~93 MB).
 */
import { createServer } from 'vite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const port = +opt('port', '5183');
const seed = +opt('seed', '7');
const coi = !flag('no-coi');
const threadList = opt('threads', '3').split(',').map(Number);
const pngOut = opt('png', null);
const timeoutMs = +opt('timeout-min', '20') * 60000;
const THRESH = { notesF1: 0.95, abortMs: 3000 };

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

/** Resident memory (MB) of the processes this script started (the browser and its children; Linux), sampled while reading. */
function browserRssMB(pid) {
  try {
    const rows = execSync('ps -e -o pid=,ppid=,rss=', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    const rss = new Map(rows.map(([p, , r]) => [p, r]));
    let total = 0;
    const todo = [...(kids.get(pid) ?? [])];
    while (todo.length) {
      const p = todo.pop();
      total += rss.get(p) ?? 0;
      todo.push(...(kids.get(p) ?? []));
    }
    return total / 1024;
  } catch {
    return 0;
  }
}

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const browserPid = process.platform === 'linux' ? process.pid : 0;
let failed = false;
const check = (ok, label, detail) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
};
const withTimeout = (p, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), timeoutMs)))]).finally(() => clearTimeout(t));
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(`http://localhost:${port}/tests/e2e/homr.html${coi ? '?coi=1' : ''}`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  console.log(`page crossOriginIsolated=${await page.evaluate(() => self.crossOriginIsolated)}, ${await page.evaluate(() => navigator.hardwareConcurrency)} cores`);
  const sup = await page.evaluate(() => window.support());
  check(sup.available && sup.downloadMB > 0, 'support ', JSON.stringify(sup));
  const piece = await page.evaluate((s) => window.makePiece(s), seed);
  console.log(`piece    seed ${seed}: ${piece.notes} notes`);
  if (pngOut) fs.writeFileSync(pngOut, Buffer.from(piece.png.split(',')[1], 'base64'));
  for (const threads of threadList) {
    // two runs per thread count: the first may download / compile, the second is the steady state
    for (const run of [1, 2]) {
      const base = browserPid ? browserRssMB(browserPid) : 0;
      let peak = base;
      const timer = browserPid ? setInterval(() => (peak = Math.max(peak, browserRssMB(browserPid))), 250) : null;
      const r = await withTimeout(page.evaluate((t) => window.readPage(t), threads), `read (${threads} threads)`);
      if (timer) clearInterval(timer);
      console.log(`read     threads ${threads} run ${run}: ${JSON.stringify(r)} browser RSS peak ${Math.round(peak)} MB (+${Math.round(peak - base)} MB)`);
      check(r.notesF1 >= THRESH.notesF1, `notes F1 (threads ${threads})`, `${r.notesF1} >= ${THRESH.notesF1} (rhythm ${r.rhythmF1})`);
      check(r.progressMax >= 0.99 && r.monotonic && r.stages.includes('reading'), `progress (threads ${threads})`, `${r.progressMax} ${r.stages.join(',')}`);
      check(r.titled, 'title in the MusicXML');
    }
  }
  const ab = await withTimeout(page.evaluate(() => window.readAbort()), 'cancel');
  check(ab.rejected && ab.name === 'AbortError' && ab.rejectAfterAbortMs <= THRESH.abortMs, 'cancel  ', JSON.stringify(ab));
} catch (err) {
  failed = true;
  console.error('FAIL', err.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
