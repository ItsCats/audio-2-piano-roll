/**
 * The two sheet-music readers as a user meets them, in Playwright Chromium on a PRODUCTION build served
 * with the exact netlify.toml headers (tests/e2e/isolation.server.py: CSP without 'unsafe-eval',
 * COOP/COEP, the long cache header on /models/homr/*.bin).
 *
 *   npm run build            (or: npx vite build --outDir DIR)
 *   node tests/e2e/reader-choice.mjs --dist dist [--port 5398] [--shots DIR] [--only desktop|iphone] [--skip-quick]
 *
 * The test material is made here: the built-in demo (Bach's Prelude in C major, public domain) exported
 * by the app as a "Sheet music PDF", and its first page rendered to a PNG with pdf.js (a clean page
 * image). The answer key is the demo's own notes; a read page is scored with notes F1 (chords aligned in
 * order, a note counts when its pitch is in the aligned chord; the same metric as tests/e2e/homrScore.ts)
 * against the stretch of the demo it covers.
 *
 * Desktop (1440x900): the Accurate reader is chosen by default ("Recommended", 93 MB, about 98%), the
 * page image and the PDF's first page are read with it (notes F1 >= 0.95 each, progress names the
 * accurate reader and its download), the song opens in the Studio without the Beta labels; then the
 * Quick reader is picked (remembered across a reload) and reads both again (F1 printed; >= 0.6);
 * crash recovery: the page is reloaded during an accurate read and the notice's "Use the Quick reader"
 * reads the kept PDF with the quick reader. iPhone 14: the Quick reader is the default, the Accurate
 * reader shows "May be too heavy for this phone…", and picking it is remembered.
 * Both: cross-origin isolated, no CSP violations, no console errors, no sideways scroll.
 * Screenshots (deviceScaleFactor 2): reader-choice-desktop.png, reader-choice-phone.png,
 * reading-accurate.png, result-studio.png and more, in --shots.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const dist = path.resolve(opt('dist', path.join(root, 'dist')));
const port = Number(opt('port', '5398'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-reader-choice-')));
const only = opt('only');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/reader-choice.mjs --dist BUILD_DIR [--port N] [--shots DIR]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const { chromium, devices } = await import('playwright');

let failed = false;
const check = (name, ok, info) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
};

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (d) => (serverLog += d));
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  iphone: { ...devices['iPhone 14'], deviceScaleFactor: 2 },
};

async function newPage(contextOpts) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...contextOpts });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return { ctx, page, errors };
}
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = (page, name, full = false) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: full });
const cardText = (page) => page.evaluate(() => document.querySelector('.panel[aria-live="polite"]')?.textContent ?? '');
const dropInput = (page) => page.locator('[role="button"] input[type="file"]').first();
const checked = (page, id) => page.locator(`[data-testid="reader-${id}"] input[type="radio"]`).isChecked();
const prefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('piano2vision-import-prefs') || '{}'));

/** Songs in IndexedDB, with their notes in quarter notes. */
const songs = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('pianovision');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const q = r.result.transaction('songs').objectStore('songs').getAll();
          q.onsuccess = () =>
            resolve(
              q.result
                .sort((a, b) => a.createdAt - b.createdAt)
                .map((s) => ({ id: s.id, title: s.title, source: s.source, notes: s.base.map((n) => ({ midi: n.midi, onset: (n.start * s.tempo.bpm) / 60 })) })),
            );
        };
      }),
  );

// ------------------------------------------------------------------ notes F1 (as tests/e2e/homrScore.ts)
function groups(notes) {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map((n) => n.onset));
  const g = new Map();
  for (const n of notes) {
    const o = Math.round((n.onset - t0) * 1e3) / 1e3;
    if (!g.has(o)) g.set(o, new Set());
    g.get(o).add(n.midi);
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0]);
}
const inter = (a, b) => [...a].filter((x) => b.has(x)).length;
function alignedHits(G, P) {
  const n = G.length;
  const m = P.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) (D[i][0] = D[i - 1][0] + G[i - 1][1].size), (B[i][0] = 1);
  for (let j = 1; j <= m; j++) (D[0][j] = D[0][j - 1] + P[j - 1][1].size), (B[0][j] = 2);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const sub = D[i - 1][j - 1] + G[i - 1][1].size + P[j - 1][1].size - 2 * inter(G[i - 1][1], P[j - 1][1]);
      const del = D[i - 1][j] + G[i - 1][1].size;
      const ins = D[i][j - 1] + P[j - 1][1].size;
      D[i][j] = Math.min(sub, del, ins);
      B[i][j] = D[i][j] === sub ? 0 : D[i][j] === del ? 1 : 2;
    }
  let tp = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && B[i][j] === 0) tp += inter(G[--i][1], P[--j][1]);
    else if (i > 0 && (j === 0 || B[i][j] === 1)) i--;
    else j--;
  }
  return tp;
}
/**
 * Notes F1 of a read page against the demo: the page holds the demo's first bars, so the truth is the
 * demo's opening up to the bar line where the read notes fit best (the page's end is not known here).
 */
function notesF1(truth, read) {
  const G = groups(truth);
  const P = groups(read);
  const nP = P.reduce((a, g) => a + g[1].size, 0);
  let best = { f1: 0, bars: 0 };
  // the prelude has 16 sixteenth-note chords per bar
  for (let end = 16; end <= G.length; end += 16) {
    const g = G.slice(0, end);
    const nG = g.reduce((a, x) => a + x[1].size, 0);
    const tp = alignedHits(g, P);
    const p = nP ? tp / nP : 0;
    const r = nG ? tp / nG : 0;
    const f1 = p + r ? (2 * p * r) / (p + r) : 0;
    if (f1 > best.f1) best = { f1: Math.round(f1 * 1000) / 1000, bars: end / 16, truth: nG, read: nP };
  }
  return best;
}

/** Watches the import card until the Studio opens; returns the progress texts seen. */
async function readUntilStudio(page, { shotName } = {}) {
  const seen = new Set();
  let shotTaken = false;
  const t0 = Date.now();
  while (!/\/studio\//.test(page.url())) {
    const t = await cardText(page).catch(() => '');
    const m = t.match(/(Downloading the [a-z ]*sheet-music reader \(once, \d+ MB\)|Starting the [a-z ]*sheet-music reader|Finding the lines of music( on page \d+ of \d+)?|Reading (page \d+ of \d+, )?line \d+ of \d+)/);
    if (m) seen.add(m[1]);
    if (shotName && !shotTaken && /Reading (page \d+ of \d+, )?line 2 of/.test(t)) {
      shotTaken = true;
      await shot(page, shotName);
    }
    if (/Import failed/.test(t)) throw new Error(`import failed: ${t.slice(0, 300)}`);
    if (Date.now() - t0 > 15 * 60_000) throw new Error('reading timed out');
    await page.waitForTimeout(250);
  }
  return { seen: [...seen], s: Math.round((Date.now() - t0) / 1000) };
}

async function openTab(page) {
  await page.goto(base + '/import?tab=midi');
  await page.getByTestId('sheet-reader-choice').waitFor();
  await page.waitForTimeout(400);
}

/** Reads the page image (as a photo: corner screen, Looks good) or the PDF's first page; returns the new song. */
async function readOne(page, what, files, opts = {}) {
  await openTab(page);
  if (what === 'pdf') {
    await dropInput(page).setInputFiles(files.pdf);
    await page.waitForSelector('[data-testid="pdf-pages"] button[aria-label^="Page "] img', { timeout: 60000 });
    const n = await page.locator('[data-testid="pdf-pages"] button[aria-label^="Page "]').count();
    for (let p = n; p > 1; p--) {
      const b = page.locator(`[data-testid="pdf-pages"] button[aria-label="Page ${p}"]`);
      if ((await b.getAttribute('aria-pressed')) === 'true') await b.click();
    }
  } else {
    await dropInput(page).setInputFiles(files.png);
    await page.waitForSelector('[data-testid="corner-editor"] [data-corner="3"]', { timeout: 30000 });
    await page.getByRole('button', { name: 'Looks good' }).click();
  }
  const before = (await songs(page)).length;
  await page.getByRole('button', { name: /^Read 1 page/ }).click();
  if (opts.beforeRead) return opts.beforeRead();
  const r = await readUntilStudio(page, opts);
  const all = await songs(page);
  return { ...r, song: all.length > before ? all[all.length - 1] : null };
}

try {
  const files = {};
  // ---- the PDF: the demo, exported by the app; its first page as a PNG (pdf.js, outside the app)
  {
    const { page, ctx } = await newPage(DEVICES.desktop);
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    await page.getByRole('button', { name: /Export/ }).last().click();
    await page.getByRole('menuitem', { name: /Sheet music PDF/ }).click();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Download PDF' }).click()]);
    files.pdf = path.join(shots, 'demo-prelude.pdf');
    await dl.saveAs(files.pdf);
    check('the app exported the demo as a PDF', fs.readFileSync(files.pdf).subarray(0, 5).toString('latin1') === '%PDF-');
    const pdfjs = path.join(root, 'node_modules/pdfjs-dist/build');
    const r = await ctx.newPage();
    await r.route('http://render.test/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      if (u.pathname === '/doc.pdf') return route.fulfill({ contentType: 'application/pdf', body: fs.readFileSync(files.pdf) });
      return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(pdfjs, path.basename(u.pathname))) });
    });
    await r.goto('http://render.test/');
    const png = await r.evaluate(async () => {
      const lib = await import('http://render.test/pdf.min.mjs');
      lib.GlobalWorkerOptions.workerSrc = 'http://render.test/pdf.worker.min.mjs';
      const doc = await lib.getDocument({ url: 'http://render.test/doc.pdf' }).promise;
      const p = await doc.getPage(1);
      const v1 = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: 1654 / v1.width });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: g, canvas: c, viewport: vp }).promise;
      return c.toDataURL('image/png');
    });
    files.png = path.join(shots, 'demo-prelude-p1.png');
    fs.writeFileSync(files.png, Buffer.from(png.split(',')[1], 'base64'));
    check('page 1 rendered as a clean page image', fs.statSync(files.png).size > 20000, { bytes: fs.statSync(files.png).size });
    await ctx.close();
  }

  // ---------------------------------------------------------------- desktop
  if (!only || only === 'desktop') {
    const dev = 'desktop';
    const { page, errors, ctx } = await newPage(DEVICES.desktop);
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const demo = (await songs(page))[0];
    check('desktop: the demo is the answer key', demo?.notes.length > 400, { notes: demo?.notes.length });

    await openTab(page);
    check(`${dev}: page is cross-origin isolated`, await page.evaluate(() => crossOriginIsolated));
    check(`${dev}: the Accurate reader is chosen by default`, (await checked(page, 'accurate')) && !(await checked(page, 'quick')));
    const accText = await page.getByTestId('reader-accurate').textContent();
    const quickText = await page.getByTestId('reader-quick').textContent();
    check(`${dev}: the Accurate reader's line`, /Accurate reader/.test(accText) && /Recommended/.test(accText) && /About 98% of notes right · 93 MB download once · about (a minute|\d+ (seconds|minutes)) per page/.test(accText), accText);
    check(`${dev}: the Quick reader's line`, /Quick reader/.test(quickText) && /Beta/.test(quickText) && /Smaller download, less accurate/.test(quickText) && /About 88% of notes right · 24 MB download once/.test(quickText), quickText);
    check(`${dev}: no "too heavy" warning on a computer`, !(await page.getByTestId('reader-heavy').count()));
    check(`${dev}: nothing of the readers downloaded yet`, await page.evaluate(() => !performance.getEntriesByType('resource').some((e) => /models\/(homr|omr)\//.test(e.name))));
    await page.getByTestId('sheet-reader-choice').screenshot({ path: path.join(shots, 'reader-choice-desktop.png') });
    await shot(page, 'desktop-tab', true);
    check(`${dev}: import tab has no sideways scroll`, (await sideScroll(page)) <= 0);

    // ---- accurate: the page image, then the PDF
    const a1 = await readOne(page, 'png', files, { shotName: 'reading-accurate' });
    check(`${dev} accurate png: progress names the accurate reader and its download`, a1.seen.some((s) => /Downloading the accurate sheet-music reader \(once, 93 MB\)/.test(s)) && a1.seen.some((s) => /Reading line 1 of \d+/.test(s)), a1);
    const f1a = a1.song && notesF1(demo.notes, a1.song.notes);
    check(`${dev} accurate png: notes F1 >= 0.95`, !!f1a && f1a.f1 >= 0.95, { ...f1a, s: a1.s });
    check(`${dev} accurate png: saved as read by the accurate reader`, a1.song?.source.sheetReader === 'accurate' && a1.song?.source.reader === 'photo', a1.song?.source);
    await page.waitForSelector('[data-testid="sheet-reader-notice"]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    check(`${dev} accurate: Studio notice and badge without Beta`, (await page.getByText('Read from sheet music', { exact: true }).first().isVisible()) && (await page.getByText('Read from photo', { exact: true }).first().isVisible()) && !(await page.getByText('Sheet music · Beta').count()));
    await shot(page, 'result-studio');
    const a2 = await readOne(page, 'pdf', files);
    const f1b = a2.song && notesF1(demo.notes, a2.song.notes);
    check(`${dev} accurate pdf: notes F1 >= 0.95`, !!f1b && f1b.f1 >= 0.95, { ...f1b, s: a2.s, seen: a2.seen });
    check(`${dev} accurate pdf: models from the cache the second time`, !a2.seen.some((s) => /Downloading/.test(s)), a2.seen);

    // ---- crash recovery: reload during an accurate read; the notice offers the quick reader
    await readOne(page, 'pdf', files, {
      beforeRead: () => page.waitForFunction(() => /Reading|Finding/.test(document.querySelector('.panel[aria-live="polite"]')?.textContent ?? ''), null, { timeout: 180000 }),
    });
    page.once('dialog', (d) => void d.accept());
    await page.reload();
    await page.getByText('Your last import was interrupted').waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    await shot(page, 'desktop-interrupted-accurate');
    check(`${dev}: the notice offers the Quick reader`, (await page.getByText(/with the Accurate reader was interrupted/).isVisible()) && (await page.getByRole('button', { name: 'Use the Quick reader' }).isVisible()));
    const nBefore = (await songs(page)).length;
    await page.getByRole('button', { name: 'Use the Quick reader' }).click();
    const rc = await readUntilStudio(page);
    const resumed = (await songs(page)).slice(nBefore)[0];
    check(`${dev}: "Use the Quick reader" read the kept PDF with the quick reader`, resumed?.source.sheetReader === 'quick' && rc.seen.some((s) => /quick sheet-music reader/.test(s)), { source: resumed?.source, seen: rc.seen });
    check(`${dev}: and the Quick reader is now picked`, (await prefs(page)).sheetReader === 'quick');

    // ---- quick: picked by hand, remembered across a reload
    await openTab(page);
    await page.getByTestId('reader-accurate').click();
    check(`${dev}: picking the Accurate reader again`, (await checked(page, 'accurate')) && (await prefs(page)).sheetReader === 'accurate');
    await page.getByTestId('reader-quick').click();
    await page.reload();
    await page.getByTestId('sheet-reader-choice').waitFor();
    check(`${dev}: the Quick reader pick is remembered`, (await checked(page, 'quick')) && (await prefs(page)).sheetReader === 'quick');
    await page.getByTestId('sheet-reader-choice').screenshot({ path: path.join(shots, 'reader-choice-desktop-quick.png') });
    if (!flag('skip-quick')) {
      for (const what of ['png', 'pdf']) {
        const q = await readOne(page, what, files);
        const f = q.song && notesF1(demo.notes, q.song.notes);
        console.log(`INFO ${dev} quick ${what}: notes F1 ${f?.f1} (bars ${f?.bars}), ${q.s} s`);
        check(`${dev} quick ${what}: read, notes F1 >= 0.6, saved as quick`, !!f && f.f1 >= 0.6 && q.song.source.sheetReader === 'quick', { ...f, s: q.s });
      }
      await page.waitForSelector('[data-testid="sheet-reader-notice"]', { timeout: 30000 });
      check(`${dev} quick: Studio keeps the Beta label`, await page.getByText('Read from sheet music (Beta)').first().isVisible());
      await shot(page, 'result-studio-quick');
    }
    await page.goto(base + '/library');
    await page.waitForTimeout(1200);
    await shot(page, 'desktop-library');
    check(`${dev}: Library labels both kinds`, (await page.getByText('AI', { exact: true }).count()) >= 1 && (await page.getByText('Beta', { exact: true }).count()) >= 1);
    const csp = await page.evaluate(() => window.__csp);
    check(`${dev}: no CSP violations`, !csp.length, csp);
    check(`${dev}: no console errors`, !errors.length, errors);
    await ctx.close();
  }

  // ---------------------------------------------------------------- iPhone 14
  if (!only || only === 'iphone') {
    const dev = 'iphone';
    const { page, errors, ctx } = await newPage(DEVICES.iphone);
    await openTab(page);
    check(`${dev}: the Quick reader is chosen by default`, (await checked(page, 'quick')) && !(await checked(page, 'accurate')));
    const accText = await page.getByTestId('reader-accurate').textContent();
    check(`${dev}: the Accurate reader warns it may be too heavy`, /May be too heavy for this phone; if the page reloads, use the Quick reader\./.test(accText) && !/Recommended/.test(accText), accText);
    check(`${dev}: phone times`, /about \d+ minutes per page on a phone/.test(accText), accText);
    await page.getByTestId('sheet-reader-choice').screenshot({ path: path.join(shots, 'reader-choice-phone.png') });
    await shot(page, 'iphone-tab', true);
    await page.getByTestId('reader-accurate').click();
    check(`${dev}: the Accurate reader can be picked (opt-in) and is remembered`, (await checked(page, 'accurate')) && (await prefs(page)).sheetReader === 'accurate');
    await page.reload();
    await page.getByTestId('sheet-reader-choice').waitFor();
    check(`${dev}: still picked after a reload`, await checked(page, 'accurate'));
    await shot(page, 'iphone-tab-accurate', true);
    check(`${dev}: import tab has no sideways scroll`, (await sideScroll(page)) <= 0);
    const csp = await page.evaluate(() => window.__csp);
    check(`${dev}: no CSP violations`, !csp.length, csp);
    check(`${dev}: no console errors`, !errors.length, errors);
    await ctx.close();
  }
  check('no duplicate headers from netlify.toml', !/DUPLICATE/.test(serverLog), serverLog.slice(0, 300));
} catch (err) {
  failed = true;
  console.error('ERROR', err);
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? 'FAILED' : 'ALL PASSED', `(screenshots: ${shots})`);
process.exit(failed ? 1 : 0);
