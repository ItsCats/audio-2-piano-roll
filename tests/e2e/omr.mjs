/**
 * End-to-end check of the sheet-music reader (beta; src/lib/omr) in Playwright Chromium on the dev
 * server: a small made-up piano piece (C major, 4/4, 8 bars, both hands, a few chords) is engraved with
 * the app's notation library (OSMD) and read back three ways —
 *   png:   the rendered page image, as a clean printed page (the PDF model);
 *   pdf:   the same page inside a PDF made with jsPDF, opened with pdf.js (worker + WASM decoders from
 *          our own origin);
 *   photo: the page as a phone photo (dark table, perspective, shadow, noise, JPEG) with its four
 *          corners given, as after the corner screen (the photo model).
 * The MusicXML of each goes through the normal score import and is scored note by note against the
 * piece (tests/e2e/omrScore.ts). Fails if notes F1 < 0.8 for png / pdf or < 0.7 for the photo, if
 * progress never reaches the end, or if cancelling does not stop the job within 3 s.
 *
 *   node tests/e2e/omr.mjs [--port 5182] [--seed 3] [--no-coi] [--png OUT.png] [--timeout-min 15]
 *
 * The first run downloads the model files from public/models/omr/ (two models, ~23 MB each).
 */
import { createServer } from 'vite';
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
const port = +opt('port', '5182');
const seed = +opt('seed', '3');
const coi = !flag('no-coi');
const pngOut = opt('png', null);
const timeoutMs = +opt('timeout-min', '15') * 60000;
const THRESH = { png: 0.8, pdf: 0.8, photo: 0.7, abortMs: 3000 };

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
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
  await page.goto(`http://localhost:${port}/tests/e2e/omr.html${coi ? '?coi=1' : ''}`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  console.log(`page crossOriginIsolated=${await page.evaluate(() => self.crossOriginIsolated)}, ${await page.evaluate(() => navigator.hardwareConcurrency)} cores`);
  const sup = await page.evaluate(() => window.support());
  check(sup.available && sup.downloadMB > 0, 'support ', JSON.stringify(sup));
  const piece = await page.evaluate((s) => window.makePiece(s), seed);
  console.log(`piece    seed ${seed}: ${piece.notes} notes, ${piece.measures} bars`);
  if (pngOut) fs.writeFileSync(pngOut, Buffer.from(piece.png.split(',')[1], 'base64'));
  for (const how of ['png', 'pdf', 'photo']) {
    const r = await withTimeout(page.evaluate((h) => window.readAs(h), how), how);
    console.log(`${how.padEnd(8)} ${JSON.stringify(r)}`);
    check(r.notesF1 >= THRESH[how], `${how} F1`, `${r.notesF1} >= ${THRESH[how]} (rhythm ${r.rhythmF1})`);
    check(r.progressMax >= 0.99 && r.stages.includes('reading'), `${how} progress`, `${r.progressMax} ${r.stages.join(',')}`);
  }
  const ab = await withTimeout(page.evaluate(() => window.readAbort()), 'cancel');
  check(ab.rejected && ab.name === 'AbortError' && ab.rejectAfterAbortMs <= THRESH.abortMs, 'cancel  ', JSON.stringify(ab));
  const again = await withTimeout(page.evaluate(() => window.readAs('png')), 'after cancel');
  check(again.notesF1 >= THRESH.png, 'after cancel', `F1 ${again.notesF1}`);
} catch (err) {
  failed = true;
  console.error('FAIL', err.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
