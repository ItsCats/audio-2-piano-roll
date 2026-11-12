/**
 * Sheet music view and exports in Playwright Chromium, on a production build served with the exact
 * netlify.toml headers (tests/e2e/isolation.server.py: CSP without 'unsafe-eval', COOP/COEP).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/sheet.mjs --dist /tmp/p2v-dist [--port 5394] [--shots DIR] [--extra file.mid|project.json …]
 *
 * Checks (one PASS/FAIL line each, JSON summary at the end):
 *  - the demo song in Sheet music view: music drawn, no CSP violations or console errors;
 *  - the cursor moves while playing; tapping a measure moves the cursor there;
 *  - MusicXML and PDF downloads arrive (MusicXML 4.0 partwise; the PDF starts with %PDF);
 *  - a synthetic dense 3-minute Hard song (generated here, made-up notes): drawn with the notation
 *    library loaded, the first music shows within 300 ms and no long task exceeds 250 ms (the
 *    one-off library start on first open is reported separately); its PDF has many pages and is
 *    made without freezing the page (no task over 400 ms);
 *  - a level with no notes, then one with notes: the music is drawn again;
 *  - iPhone 14 size: no sideways page scroll at any zoom.
 * `--extra` files (MIDI, or Piano2Vision project files) are opened too, for screenshots only; they
 * and the screenshots stay outside the repo (`--shots`, default: the OS temp folder).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const extras = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--extra') extras.push(args[i + 1]);
const dist = opt('dist');
const port = Number(opt('port', '5394'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheet-')));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/sheet.mjs --dist BUILD_DIR [--port N] [--shots DIR] [--extra FILE …]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const { chromium, devices } = await import('playwright');
const { Midi } = require('@tonejs/midi');

/** A made-up dense piece: 3 minutes at 120 BPM, right-hand 16ths, left-hand 8ths and bass. */
function denseMidi(file) {
  let seed = 42;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const midi = new Midi();
  midi.header.setTempo(120);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  midi.header.update();
  const rh = midi.addTrack();
  rh.name = 'Right Hand';
  const lh = midi.addTrack();
  lh.name = 'Left Hand';
  const scale = [0, 2, 4, 5, 7, 9, 11];
  for (let bar = 0; bar < 90; bar++) {
    const root = scale[bar % 7];
    for (let i = 0; i < 16; i++) {
      const t = bar * 2 + i * 0.125 + (r() - 0.5) * 0.02;
      const deg = (i * 2 + Math.floor(r() * 3)) % 14;
      rh.addNote({ midi: 72 + root + scale[deg % 7] + 12 * Math.floor(deg / 7) - 12, time: Math.max(0, t), duration: 0.11, velocity: 0.6 });
      if (i % 4 === 0 && r() < 0.5) rh.addNote({ midi: 79 + root, time: Math.max(0, t), duration: 0.24, velocity: 0.7 });
    }
    for (let i = 0; i < 8; i++) lh.addNote({ midi: 48 + root + [0, 7, 12, 7][i % 4], time: bar * 2 + i * 0.25, duration: 0.23, velocity: 0.5 });
    lh.addNote({ midi: 36 + root, time: bar * 2, duration: 1.9, velocity: 0.6 });
  }
  fs.writeFileSync(file, Buffer.from(midi.toArray()));
}

const results = [];
let failed = false;
const check = (name, ok, info) => {
  results.push({ name, ok, info });
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
};

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const summary = {};

async function newPage(contextOpts) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...contextOpts });
  await ctx.addInitScript(() => {
    window.__csp = [];
    window.__long = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return { ctx, page, errors };
}

const sheetReady = (page) => page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
const cursor = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="sheet-cursor"]');
    const r = el?.getBoundingClientRect();
    return r && el.style.display !== 'none' ? { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height) } : null;
  });
async function openDemo(page) {
  await page.goto(base + '/');
  await page.getByText('Try the demo').first().click();
  await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
}
async function toSheet(page) {
  await page.getByRole('radio', { name: /Sheet music/ }).click();
  await sheetReady(page);
}
async function download(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), action()]);
  const file = path.join(shots, dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}
async function exportItem(page, label) {
  await page.getByRole('button', { name: /Export/ }).last().click();
  await page.getByRole('menuitem', { name: label }).click();
}
const pdfPages = (file) => (fs.readFileSync(file, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
async function pdfOf(page) {
  return download(page, async () => {
    await exportItem(page, /Sheet music PDF/);
    await page.getByRole('button', { name: 'Download PDF' }).click();
  });
}

try {
  // ---- desktop: demo
  {
    const { page, errors, ctx } = await newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await openDemo(page);
    await toSheet(page);
    await page.waitForTimeout(800);
    check('demo: sheet music is drawn', (await page.locator('.sheet-chunk svg').count()) > 0);
    check('demo: page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated));
    await page.screenshot({ path: path.join(shots, 'desktop-demo-sheet.png') });
    const c0 = await cursor(page);
    await page.getByRole('button', { name: /^Play/ }).first().click();
    await page.waitForTimeout(3000);
    const c1 = await cursor(page);
    await page.getByRole('button', { name: /^Pause/ }).first().click();
    check('demo: cursor moves while playing', !!c0 && !!c1 && (c1.x !== c0.x || c1.y !== c0.y), { c0, c1 });
    await page.screenshot({ path: path.join(shots, 'desktop-demo-playing.png') });
    // tap a measure on the third line
    const target = await page.evaluate(() => {
      const svgs = [...document.querySelectorAll('.sheet-chunk svg')];
      const r = (svgs[1] ?? svgs[0]).getBoundingClientRect();
      return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.3 };
    });
    const scrollTop = () => page.evaluate(() => document.querySelector('[data-testid="sheet-scroll"]').scrollTop);
    const s0 = await scrollTop();
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(400);
    const c2 = await cursor(page);
    const s1 = await scrollTop();
    check('demo: tapping a measure moves the cursor there (and keeps the view still)', !!c2 && s1 === s0 && Math.abs(c2.x - target.x) < 140 && target.y >= c2.y - 40 && target.y <= c2.y + c2.h + 40, { target, c2, s0, s1 });
    // trackpad pinch (many small ctrl + wheel events): small gestures do nothing, a real one
    // zooms in 10 % steps and draws the music once, when the gesture ends
    const zoomLabel = () => page.locator('button[title="Reset size"]').innerText();
    const renders = () => page.evaluate(() => performance.getEntriesByName('sheet:render-start').length);
    const wheel = async (n, dy) => {
      await page.mouse.move(700, 500);
      for (let i = 0; i < n; i++) await page.mouse.wheel(0, dy).catch(() => undefined);
    };
    await page.keyboard.down('Control');
    const r0 = await renders();
    await wheel(20, -2);
    const z1 = await zoomLabel();
    await wheel(10, -10);
    await page.keyboard.up('Control');
    await page.waitForTimeout(1500);
    const z2 = await zoomLabel();
    const r1 = await renders();
    check('demo: a pinch zooms in steps and redraws once', z1 === '100%' && ['110%', '120%'].includes(z2) && r1 - r0 === 1, { z1, z2, redraws: r1 - r0 });
    await page.locator('button[title="Reset size"]').click();
    await page.waitForTimeout(1200);
    const xml = await download(page, () => exportItem(page, /MusicXML/));
    const xmlText = fs.readFileSync(xml, 'utf8');
    check('demo: MusicXML download', xmlText.startsWith('<?xml') && xmlText.includes('<score-partwise version="4.0">') && xmlText.includes('Transcribed with Piano2Vision'), path.basename(xml));
    await page.waitForTimeout(500);
    const pdf = await pdfOf(page);
    const head = fs.readFileSync(pdf).subarray(0, 5).toString('latin1');
    summary.demoPdf = { bytes: fs.statSync(pdf).size, pages: pdfPages(pdf) };
    check('demo: PDF download', head === '%PDF-' && summary.demoPdf.pages >= 1, summary.demoPdf);
    // a level with no notes, then back to one with notes: the music is drawn again
    await page.getByRole('radio', { name: /Piano roll/ }).click();
    await page.getByRole('radio', { name: /easy/i }).click();
    await page.keyboard.press('e');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.press('e');
    await page.getByRole('radio', { name: /medium/i }).click();
    await toSheet(page);
    await page.getByRole('radio', { name: /easy/i }).click();
    await page.getByText('No notes to show yet.').waitFor({ timeout: 10000 });
    await page.getByRole('radio', { name: /medium/i }).click();
    const redrawn = await page
      .waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('demo: music comes back after a level with no notes', redrawn, { chunks: await page.locator('.sheet-chunk svg').count() });
    const csp = await page.evaluate(() => window.__csp);
    check('demo: no CSP violations or console errors', !csp.length && !errors.length, { csp, errors });
    await ctx.close();
  }

  // ---- desktop: synthetic dense 3-minute song on Hard
  {
    const midiFile = path.join(shots, 'dense-synthetic.mid');
    denseMidi(midiFile);
    const { page, errors, ctx } = await newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(base + '/import?tab=midi');
    await page.setInputFiles('input[type=file]', midiFile);
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const allDrawn = (n) =>
      page.waitForFunction((k) => performance.getEntriesByName('sheet:all-chunks').length >= k, n, { timeout: 60000 });
    const marks = () => page.evaluate(() => Object.fromEntries(['render-start', 'library-ready', 'first-chunk', 'all-chunks'].map((k) => [k, Math.round(performance.getEntriesByName('sheet:' + k).at(-1)?.startTime ?? -1)])));
    const span = (m) => ({ firstMs: m['first-chunk'] - m['render-start'], allMs: m['all-chunks'] - m['render-start'] });
    await page.getByRole('radio', { name: /hard/i }).click();
    await page.waitForTimeout(500);
    // first open: includes loading the notation library (one-off, ~1.4 MB of code to start)
    await page.evaluate(() => (window.__long.length = 0));
    await toSheet(page);
    await allDrawn(1);
    const m1 = await marks();
    const long1 = await page.evaluate(() => window.__long.slice());
    summary.denseFirstOpen = { ...span(m1), libraryMs: m1['library-ready'] - m1['render-start'], maxLongTask: Math.max(0, ...long1) };
    // drawing the dense song again (Medium → Hard) with the library loaded: the song's own cost
    await page.getByRole('radio', { name: /medium/i }).click();
    await allDrawn(2);
    await page.waitForTimeout(300);
    await page.evaluate(() => (window.__long.length = 0));
    await page.getByRole('radio', { name: /hard/i }).click();
    await allDrawn(3);
    const m2 = await marks();
    const long2 = await page.evaluate(() => window.__long.slice());
    summary.dense = { ...span(m2), longTasks: long2.length, maxLongTask: Math.max(0, ...long2), chunks: await page.locator('.sheet-chunk').count() };
    check('dense Hard: first music within 300 ms, no long task over 250 ms while drawing', summary.dense.firstMs < 300 && summary.dense.maxLongTask < 250, summary);
    await page.screenshot({ path: path.join(shots, 'desktop-dense-hard.png') });
    await page.evaluate(() => (window.__long.length = 0));
    const t0 = Date.now();
    const pdf = await pdfOf(page);
    const longPdf = await page.evaluate(() => window.__long.slice());
    summary.densePdf = { bytes: fs.statSync(pdf).size, pages: pdfPages(pdf), ms: Date.now() - t0, maxLongTask: Math.max(0, ...longPdf), longTasks: longPdf.length };
    check('dense Hard: PDF has many pages', summary.densePdf.pages > 3, summary.densePdf);
    check('dense Hard: the page stays responsive while the PDF is made (no task over 400 ms)', summary.densePdf.maxLongTask < 400, summary.densePdf);
    check('dense Hard: no console errors', !errors.length, errors);
    await ctx.close();
  }

  // ---- extra local files (screenshots only), each in a fresh browser
  for (const f of extras) {
    for (const [kind, viewport] of [['desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }], ['phone', { ...devices['iPhone 14'], deviceScaleFactor: 2 }]]) {
      const { page, errors, ctx } = await newPage(viewport);
      if (f.endsWith('.json')) {
        // a project file is added to the library; open the newest song
        await page.goto(base + '/library');
        await page.setInputFiles('input[accept=".json,application/json"]', f);
        await page.getByText('Project imported').waitFor({ timeout: 60000 });
        await page.locator('a[href^="/studio/"]').first().click();
      } else {
        await page.goto(base + '/import?tab=midi');
        await page.setInputFiles('input[type=file]', f);
      }
      await page.waitForURL(/\/studio\/.+/, { timeout: 120000 });
      const view = page.getByRole('radio', { name: /Sheet music/ });
      if ((await view.getAttribute('aria-checked')) !== 'true') await view.click();
      for (const level of ['easy', 'hard']) {
        await page.getByRole('radio', { name: new RegExp(level, 'i') }).click();
        await sheetReady(page);
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(shots, `extra-${path.basename(f).replace(/\W+/g, '_').slice(-40)}-${level}-${kind}.png`) });
      }
      check(`extra ${path.basename(f).slice(-40)} (${kind}): no console errors`, !errors.length, errors);
      await ctx.close();
    }
  }

  // ---- phone
  {
    const { page, errors, ctx } = await newPage({ ...devices['iPhone 14'], deviceScaleFactor: 2 });
    await openDemo(page);
    await toSheet(page);
    await page.waitForTimeout(800);
    const widths = [];
    widths.push(await page.evaluate(() => document.documentElement.scrollWidth));
    await page.screenshot({ path: path.join(shots, 'phone-demo-sheet.png') });
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Bigger' }).click();
    await page.waitForTimeout(1200);
    widths.push(await page.evaluate(() => document.documentElement.scrollWidth));
    await page.screenshot({ path: path.join(shots, 'phone-demo-sheet-zoomed.png') });
    for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Smaller' }).click().catch(() => undefined);
    await page.waitForTimeout(1200);
    widths.push(await page.evaluate(() => document.documentElement.scrollWidth));
    check('phone: no sideways page scroll at any zoom', widths.every((w) => w <= 390), widths);
    const csp = await page.evaluate(() => window.__csp);
    check('phone: no CSP violations or console errors', !csp.length && !errors.length, { csp, errors });
    await ctx.close();
  }
} catch (e) {
  check('run', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify({ summary, shots }, null, 1));
process.exit(failed ? 1 : 0);
