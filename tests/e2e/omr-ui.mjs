/**
 * The sheet-music reader (beta) as a user meets it, in Playwright Chromium on a production build served
 * with the exact netlify.toml headers (tests/e2e/isolation.server.py: CSP without 'unsafe-eval', COOP/COEP).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/omr-ui.mjs --dist /tmp/p2v-dist --photo PHOTO.jpg [--photo2 PHOTO2.jpg] [--pdf FILE.pdf] [--port 5396] [--shots DIR]
 *
 * Without --pdf, the PDF is made by the app itself: the built-in demo (Bach's Prelude in C major, public
 * domain) exported with "Sheet music PDF". The photo should be a public-domain or made-up piece (the
 * reader's own e2e test, tests/e2e/omr.mjs --png, makes a page that can be photographed or degraded).
 *
 * On desktop (1440×900) and iPhone 14: the "MIDI / Sheet music" tab shows the Beta label (and "Take a
 * photo" on the phone); a PDF opens with page thumbnails, the chosen pages are read with the progress
 * card ("Downloading the sheet-music reader…", "Reading page 1 of 2, line 1 of 4…") and open in the
 * Studio with the Beta notice and badge, on Hard and Easy and in the Sheet music view; Cancel stops a
 * read at once; a photo gets the corner screen, whose corners are dragged by touch (phone) or mouse,
 * and is read after "Looks good"; the Library labels the songs; the Accuracy page has the section.
 * Desktop also: two photos as two pages (corner screen for each, reordered, "Reading page 2 of 2"), a
 * HEIC photo the browser cannot open (a plain message), and crash recovery (the page is reloaded
 * mid-read; the "interrupted" notice's Try again reads the kept photo).
 * No CSP violations, console errors or sideways page scroll; the page is cross-origin isolated.
 * Screenshots go to --shots (default: the OS temp folder).
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
const dist = opt('dist');
const photo = opt('photo') && path.resolve(opt('photo'));
const photo2 = opt('photo2') ? path.resolve(opt('photo2')) : photo;
let pdfFile = opt('pdf') && path.resolve(opt('pdf'));
const port = Number(opt('port', '5396'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-omr-ui-')));
const only = opt('only'); // desktop | iphone
const dsf = Number(opt('dsf', '1')); // desktop screenshots' device scale factor
if (!dist || !fs.existsSync(path.join(dist, 'index.html')) || !photo || !fs.existsSync(photo)) {
  console.error('usage: node tests/e2e/omr-ui.mjs --dist BUILD_DIR --photo PHOTO.jpg [--pdf FILE.pdf] [--port N] [--shots DIR]');
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
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: dsf },
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
const sheetReady = (page) => page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });

/** Watches the import card until the Studio opens; returns the progress texts seen. */
async function readUntilStudio(page, tag, { midShot = true } = {}) {
  const seen = new Set();
  let shotTaken = false;
  const t0 = Date.now();
  while (!/\/studio\//.test(page.url())) {
    const t = await cardText(page).catch(() => '');
    const m = t.match(/(Preparing[^·]*|Downloading the sheet-music reader[^·]*|Starting the sheet-music reader[^·]*|Finding the lines[^·]*|Reading (page \d+ of \d+, )?line \d+ of \d+[^·]*)/);
    if (m) seen.add(m[1].replace(/….*$/, '…').trim());
    if (midShot && !shotTaken && /Reading (page|line)/.test(t)) {
      shotTaken = true;
      await shot(page, `${tag}-progress`);
    }
    if (/Import failed/.test(t)) throw new Error(`import failed: ${t.slice(0, 300)}`);
    if (Date.now() - t0 > 10 * 60_000) throw new Error('reading timed out');
    await page.waitForTimeout(250);
  }
  return { seen: [...seen], ms: Date.now() - t0 };
}

/** Studio checks for a read song: notice, badge, Hard / Easy roll, sheet music view, tips. */
async function studioChecks(page, dev, tag) {
  await page.waitForSelector('[data-testid="sheet-reader-notice"]', { timeout: 30000 });
  await page.waitForTimeout(1200);
  check(`${dev} ${tag}: Studio shows "Read from sheet music (Beta)"`, await page.getByText('Read from sheet music (Beta)').first().isVisible());
  check(`${dev} ${tag}: header badge "Sheet music · Beta"`, await page.getByText('Sheet music · Beta').first().isVisible());
  await shot(page, `${dev}-${tag}-studio`);
  for (const level of ['hard', 'easy']) {
    await page.getByRole('radio', { name: new RegExp(level, 'i') }).first().click();
    await page.waitForTimeout(700);
    await shot(page, `${dev}-${tag}-roll-${level}`);
  }
  const notes = await page.evaluate(() => [...document.querySelectorAll('[role="radio"]')].map((r) => r.textContent).join(' | '));
  await page.getByRole('radio', { name: /Sheet music/ }).click();
  await sheetReady(page);
  for (const level of ['easy', 'hard']) {
    await page.getByRole('radio', { name: new RegExp(level, 'i') }).first().click();
    await page.waitForTimeout(1200);
    await sheetReady(page);
    check(`${dev} ${tag}: ${level} sheet music drawn`, (await page.locator('.sheet-chunk svg').count()) > 0);
    await shot(page, `${dev}-${tag}-sheet-${level}`);
  }
  check(`${dev} ${tag}: sheet view says Beta`, await page.getByText(/\(Beta\) — may contain mistakes/).first().isVisible());
  await page.getByRole('radio', { name: /Piano roll/ }).click().catch(() => undefined);
  await page.getByRole('button', { name: 'How to fix notes' }).click();
  await page.getByRole('dialog', { name: 'Check the notes' }).waitFor();
  await page.waitForTimeout(300);
  await shot(page, `${dev}-${tag}-tips`);
  await page.getByRole('button', { name: 'Start editing' }).click();
  await page.waitForTimeout(500);
  check(`${dev} ${tag}: "Start editing" opens Edit mode`, await page.getByText('EDIT', { exact: true }).first().isVisible());
  await page.getByRole('button', { name: /Edit notes|Editing/ }).first().click();
  check(`${dev} ${tag}: Studio has no sideways scroll`, (await sideScroll(page)) <= 0);
  return notes;
}

/** The songs in IndexedDB (to compare a read song with the demo). */
const songs = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('pianovision');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const tx = r.result.transaction('songs');
          const q = tx.objectStore('songs').getAll();
          q.onsuccess = () => resolve(q.result.map((s) => ({ id: s.id, title: s.title, source: s.source, base: s.base.map((n) => n.midi) })));
        };
      }),
  );
/** pitch-multiset F1 (order-free: a rough check that the right notes came out) */
function pitchF1(ref, est) {
  const count = (a) => a.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const a = count(ref);
  const b = count(est);
  let hit = 0;
  for (const [k, v] of b) hit += Math.min(v, a.get(k) ?? 0);
  const p = hit / Math.max(1, est.length);
  const r = hit / Math.max(1, ref.length);
  return p + r ? (2 * p * r) / (p + r) : 0;
}

/** A touch drag by CDP (Playwright's touchscreen only taps). */
async function touchDrag(page, from, to, { steps = 12, hold } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  if (hold) await hold();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
async function mouseDrag(page, from, to, { hold } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (hold) await hold();
  await page.mouse.up();
}
const cornerCenter = (page, i) =>
  page.evaluate((i) => {
    const r = document.querySelector(`[data-corner="${i}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i);

try {
  // ---- the PDF: the demo, exported by the app
  if (!pdfFile) {
    const { page, ctx } = await newPage(DEVICES.desktop);
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    await page.getByRole('button', { name: /Export/ }).last().click();
    await page.getByRole('menuitem', { name: /Sheet music PDF/ }).click();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Download PDF' }).click()]);
    pdfFile = path.join(shots, 'demo-prelude.pdf');
    await dl.saveAs(pdfFile);
    const pages = (fs.readFileSync(pdfFile, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    check('the app exported the demo as a PDF', fs.readFileSync(pdfFile).subarray(0, 5).toString('latin1') === '%PDF-', { pages, bytes: fs.statSync(pdfFile).size });
    await ctx.close();
  }

  for (const [dev, opts] of Object.entries(DEVICES)) {
    if (only && only !== dev) continue;
    const phone = dev === 'iphone';
    const { page, errors, ctx } = await newPage(opts);
    // the reference: the demo's own notes
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const demo = (await songs(page))[0];

    // ---- the tab
    await page.goto(base + '/import?tab=midi');
    await page.getByText('PDFs and photos of sheet music').waitFor();
    await page.waitForTimeout(500);
    await shot(page, `${dev}-tab`, true);
    check(`${dev}: page is cross-origin isolated`, await page.evaluate(() => crossOriginIsolated));
    check(`${dev}: Beta badge and its line`, (await page.getByText('Beta', { exact: true }).first().isVisible()) && (await page.getByText('Works best with clear printed piano music. Check the notes afterwards.').isVisible()));
    check(`${dev}: no "coming soon"`, !(await page.getByText(/coming soon/i).count()));
    const takePhoto = page.getByRole('button', { name: 'Take a photo of sheet music' });
    check(`${dev}: "Take a photo" ${phone ? 'shown' : 'hidden'}`, (await takePhoto.isVisible().catch(() => false)) === phone);
    if (phone) check('iphone: phone advice (time and memory) shown', await page.getByText(/Reading sheet music on a phone is slow/).isVisible());
    check(`${dev}: import tab has no sideways scroll`, (await sideScroll(page)) <= 0);

    // ---- PDF: thumbnails, pick pages, read
    await dropInput(page).setInputFiles(pdfFile);
    await page.waitForSelector('[data-testid="pdf-pages"] button[aria-label^="Page "] img', { timeout: 60000 });
    await page.waitForTimeout(800);
    const nThumbs = await page.locator('[data-testid="pdf-pages"] button[aria-label^="Page "]').count();
    check(`${dev} pdf: page thumbnails shown`, nThumbs >= 1, { pages: nThumbs });
    // desktop reads the first two pages (multi-page progress), the phone the first page
    const want = phone ? 1 : Math.min(2, nThumbs);
    for (let p = nThumbs; p > want; p--) {
      const b = page.locator(`[data-testid="pdf-pages"] button[aria-label="Page ${p}"]`);
      if ((await b.getAttribute('aria-pressed')) === 'true') await b.click();
    }
    await shot(page, `${dev}-pdf-pages`, true);
    check(`${dev} pdf: side scroll with thumbnails`, (await sideScroll(page)) <= 0);
    await page.getByRole('button', { name: new RegExp(`^Read ${want} page`) }).click();
    const r1 = await readUntilStudio(page, `${dev}-pdf`);
    check(`${dev} pdf: progress said what it does`, r1.seen.some((s) => /Downloading the sheet-music reader \(once, \d+ MB\)/.test(s)) && r1.seen.some((s) => /Reading (page 1 of 2, )?line 1 of \d+/.test(s)), r1);
    if (want > 1) check(`${dev} pdf: progress names the page`, r1.seen.some((s) => /Reading page 2 of 2, line \d+ of \d+/.test(s)));
    await studioChecks(page, dev, 'pdf');
    const read = (await songs(page)).find((s) => s.source.reader === 'pdf');
    check(`${dev} pdf: saved as read from a PDF`, !!read && read.source.kind === 'score' && read.source.pages === want, read && { title: read.title, source: read.source, notes: read.base.length });
    if (read && demo && !phone) {
      // two of the demo's three pages: compare with the first two thirds of its notes
      const total = (fs.readFileSync(pdfFile, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;
      const f1 = pitchF1(demo.base.slice(0, Math.round((demo.base.length * want) / total)), read.base);
      console.log(`INFO ${dev} pdf: pitch F1 against the demo's notes (rough, order-free): ${f1.toFixed(3)}`);
    }

    // ---- cancel
    await page.goto(base + '/import?tab=midi');
    await dropInput(page).setInputFiles(pdfFile);
    await page.waitForSelector('[data-testid="pdf-pages"] button[aria-label^="Page "] img', { timeout: 60000 });
    for (let p = nThumbs; p > 1; p--) {
      const b = page.locator(`[data-testid="pdf-pages"] button[aria-label="Page ${p}"]`);
      if ((await b.getAttribute('aria-pressed')) === 'true') await b.click();
    }
    await page.getByRole('button', { name: /^Read 1 page/ }).click();
    await page.waitForFunction(() => /Reading|Finding/.test(document.querySelector('.panel[aria-live="polite"]')?.textContent ?? ''), null, { timeout: 120000 });
    await shot(page, `${dev}-cancel-before`);
    const tc = Date.now();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('.panel[aria-live="polite"]'), null, { timeout: 3000 }).catch(() => undefined);
    const gone = !(await page.locator('.panel[aria-live="polite"]').count());
    check(`${dev}: Cancel stops reading at once`, gone && Date.now() - tc < 3000, { ms: Date.now() - tc });
    await page.waitForTimeout(1500);
    check(`${dev}: a cancelled read adds no song`, (await songs(page)).filter((s) => s.source.reader).length === 1 && /\/import/.test(page.url()));
    await shot(page, `${dev}-cancel-after`);

    // ---- photo: corner screen, drag a corner, read
    await page.goto(base + '/import?tab=midi');
    await page.getByText('PDFs and photos of sheet music').waitFor();
    if (phone) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), takePhoto.click()]);
      check('iphone: "Take a photo" opens the camera picker', (await chooser.element().getAttribute('capture')) === 'environment');
      await chooser.setFiles(photo);
    } else {
      await dropInput(page).setInputFiles(photo);
    }
    await page.waitForSelector('[data-testid="corner-editor"] [data-corner="3"]', { timeout: 30000 });
    await page.waitForTimeout(600);
    await shot(page, `${dev}-corners`);
    check(`${dev} photo: corner screen with four corners`, (await page.locator('[data-corner]').count()) === 4);
    const handleSize = await page.evaluate(() => document.querySelector('[data-corner="0"]').getBoundingClientRect().width);
    check(`${dev} photo: corner handles are large enough to touch (≥ 44 px)`, handleSize >= 44, { px: handleSize });
    // drag the top-left corner away and back to where it was, with the magnifier showing mid-drag
    const c0 = await cornerCenter(page, 0);
    const away = { x: c0.x + 60, y: c0.y + 70 };
    const drag = phone ? touchDrag : mouseDrag;
    let loupe = false;
    await drag(page, c0, away, {
      hold: async () => {
        loupe = await page.evaluate(() => !!document.querySelector('[data-testid="corner-editor"] .rounded-full.border-white[aria-hidden]'));
        await shot(page, `${dev}-corners-dragging`);
      },
    });
    const c1 = await cornerCenter(page, 0);
    check(`${dev} photo: the corner follows the ${phone ? 'finger' : 'mouse'}`, Math.abs(c1.x - away.x) < 4 && Math.abs(c1.y - away.y) < 4, { from: c0, to: c1 });
    check(`${dev} photo: the magnifier shows while dragging`, loupe);
    await drag(page, c1, c0);
    const c2 = await cornerCenter(page, 0);
    check(`${dev} photo: dragged back`, Math.abs(c2.x - c0.x) < 4 && Math.abs(c2.y - c0.y) < 4);
    check(`${dev} photo: corner screen has no sideways scroll`, (await sideScroll(page)) <= 0);
    // Retake, then cancel the picker: the photo and its corners stay (it used to be deleted first)
    const retakeName = phone ? 'Retake' : 'Choose another photo';
    const before = await cornerCenter(page, 2);
    const [chooser1] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: retakeName }).click()]);
    void chooser1; // not answered: as if the camera or picker was cancelled
    await page.waitForTimeout(500);
    const stillThere = (await page.locator('[data-corner]').count()) === 4 && JSON.stringify(await cornerCenter(page, 2)) === JSON.stringify(before);
    check(`${dev} photo: cancelling Retake keeps the photo and its corners`, stillThere);
    // Retake with a new photo: it takes the old one's place (still one page)
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: retakeName }).click()]);
    await chooser2.setFiles(photo2);
    await page.waitForTimeout(1500);
    await page.waitForSelector('[data-testid="corner-editor"] [data-corner="3"]', { timeout: 30000 });
    check(`${dev} photo: corner screen has the focus (keyboard users)`, await page.evaluate(() => !!document.activeElement?.closest('[data-testid="corner-editor"]')));
    await page.getByRole('button', { name: 'Looks good' }).click();
    await page.getByRole('button', { name: /^Read 1 page/ }).waitFor();
    check(`${dev} photo: a retaken photo replaces the old one`, (await page.locator('[data-testid="photo-pages"] li img').count()) === 1);
    await shot(page, `${dev}-photo-list`, true);
    await page.getByRole('button', { name: /^Read 1 page/ }).click();
    const r2 = await readUntilStudio(page, `${dev}-photo`);
    check(`${dev} photo: read with progress`, r2.seen.some((s) => /Reading line 1 of \d+/.test(s)), r2);
    await studioChecks(page, dev, 'photo');

    if (phone) {
      // ---- more photos than a phone reads at once: the first 3 are kept, and it says so
      await page.goto(base + '/import?tab=midi');
      await page.getByText('PDFs and photos of sheet music').waitFor();
      await dropInput(page).setInputFiles([photo, photo2, photo, photo2]);
      await page.getByRole('alert').waitFor({ timeout: 30000 });
      check('iphone photos: only the first 3 of 4 are added, with a plain note', /Only the first 3 photos were added: up to 3 pages/.test(await page.getByRole('alert').innerText()));
      await page.getByText('Page 1: adjust the corners').waitFor({ timeout: 30000 });
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Looks good' }).click();
      await page.getByRole('button', { name: /^Read 3 pages/ }).waitFor();
      check('iphone photos: 3 pages listed, no "add" buttons', (await page.locator('[data-testid="photo-pages"] li img').count()) === 3 && !(await page.getByRole('button', { name: 'Photo of the next page' }).count()));
      await page.getByRole('button', { name: 'Start over' }).click();
    }

    if (!phone) {
      // ---- a long PDF: "Show more pages" after 30 (made here with jsPDF: 35 pages of staff lines)
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      for (let i = 0; i < 35; i++) {
        if (i) doc.addPage();
        doc.text(`Page ${i + 1}`, 20, 20);
        for (let l = 0; l < 5; l++) doc.line(20, 40 + l * 2, 190, 40 + l * 2);
      }
      const longPdf = path.join(shots, 'long-35-pages.pdf');
      fs.writeFileSync(longPdf, Buffer.from(doc.output('arraybuffer')));
      await page.goto(base + '/import?tab=midi');
      await dropInput(page).setInputFiles(longPdf);
      await page.waitForSelector('[data-testid="pdf-pages"] button[aria-label="Page 30"] img', { timeout: 60000 });
      check(`${dev} long pdf: 30 thumbnails first`, (await page.locator('[data-testid="pdf-pages"] button[aria-label^="Page "]').count()) === 30);
      await page.getByRole('button', { name: /Show more pages \(31–35 of 35\)/ }).click();
      await page.waitForSelector('[data-testid="pdf-pages"] button[aria-label="Page 35"] img', { timeout: 60000 });
      check(`${dev} long pdf: "Show more pages" shows the rest`, (await page.locator('[data-testid="pdf-pages"] button[aria-label^="Page "]').count()) === 35);
      // 10 are chosen: tapping an 11th says why instead of doing nothing
      await page.locator('[data-testid="pdf-pages"] button[aria-label="Page 33"]').click({ force: true }); // aria-disabled: still answers a tap
      check(`${dev} long pdf: an 11th page says "up to 10 pages"`, await page.getByText(/Up to 10 pages can be read at a time\. Tap a chosen page to remove it first/).isVisible());
      await page.getByRole('button', { name: 'Choose another file' }).click();

      // ---- two photos, two pages: a corner screen for each, then reordered
      await page.goto(base + '/import?tab=midi');
      await dropInput(page).setInputFiles([photo, photo2]);
      await page.getByText('Page 1: adjust the corners').waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Looks good' }).click();
      await page.getByText('Page 2: adjust the corners').waitFor({ timeout: 10000 });
      await shot(page, `${dev}-two-photos-page2`);
      await page.getByRole('button', { name: 'Looks good' }).click();
      await page.getByRole('button', { name: /^Read 2 pages/ }).waitFor();
      const order0 = await page.locator('[data-testid="photo-pages"] li img').evaluateAll((els) => els.map((e) => e.getAttribute('src')?.length));
      await page.getByRole('button', { name: 'Move earlier' }).nth(1).click();
      const order1 = await page.locator('[data-testid="photo-pages"] li img').evaluateAll((els) => els.map((e) => e.getAttribute('src')?.length));
      check(`${dev} photos: pages can be reordered`, order0.length === 2 && order1[0] === order0[1] && order1[1] === order0[0]);
      await shot(page, `${dev}-two-photos-list`, true);
      await page.getByRole('button', { name: /^Read 2 pages/ }).click();
      const r3 = await readUntilStudio(page, `${dev}-two-photos`, { midShot: false });
      check(`${dev} photos: two pages read in order`, r3.seen.some((t) => /Reading page 2 of 2, line \d+ of \d+/.test(t)), r3.seen.filter((t) => /Reading/.test(t)));
      await page.waitForSelector('[data-testid="sheet-reader-notice"]', { timeout: 30000 });

      // ---- a HEIC photo this browser cannot open
      await page.goto(base + '/import?tab=midi');
      await dropInput(page).setInputFiles({ name: 'IMG_0001.heic', mimeType: 'image/heic', buffer: Buffer.from('not really a heic file') });
      await page.getByRole('alert').waitFor({ timeout: 15000 });
      const heic = await page.getByRole('alert').innerText();
      check(`${dev}: a HEIC photo the browser cannot open gets a plain message`, /is in HEIC format, which this browser can’t open\. Choose it again from the Photos app/.test(heic), heic);
      check(`${dev}: the photo picker lets the phone convert HEIC (accept image/* only)`, (await page.locator('input[type="file"][multiple][accept]').evaluateAll((els) => els.map((e) => e.getAttribute('accept')))).every((a) => a === 'image/*' || a === ''));
      await shot(page, `${dev}-heic`);

      // ---- crash recovery: reload mid-read, then Try again from the notice
      await page.goto(base + '/import?tab=midi');
      await dropInput(page).setInputFiles(photo);
      await page.getByRole('button', { name: 'Looks good' }).click();
      await page.getByRole('button', { name: /^Read 1 page/ }).click();
      await page.waitForFunction(() => /Reading|Finding/.test(document.querySelector('.panel[aria-live="polite"]')?.textContent ?? ''), null, { timeout: 120000 });
      const pending = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open('pianovision');
            r.onsuccess = () => {
              const q = r.result.transaction('pending').objectStore('pending').getAll();
              q.onsuccess = () => resolve(q.result.map((x) => ({ kind: x.kind, sheet: x.sheet?.kind, photos: x.sheet?.photos?.length, quad: !!x.sheet?.photos?.[0]?.quad, blob: !!x.blob })));
            };
          }),
      );
      check(`${dev}: the photo is kept for crash recovery while reading`, pending.length === 1 && pending[0].sheet === 'photo' && pending[0].photos === 1 && pending[0].quad && pending[0].blob, pending);
      page.once('dialog', (d) => void d.accept());
      await page.reload();
      await page.getByText('Your last import was interrupted').waitFor({ timeout: 20000 });
      await page.waitForTimeout(400);
      await shot(page, `${dev}-interrupted`);
      check(`${dev}: the notice says the photo was kept and Try again uses less memory`, (await page.getByText(/Your photo was kept/).isVisible()) && (await page.getByText(/slower mode that uses less memory/).isVisible()));
      await page.getByRole('button', { name: 'Try again' }).click();
      await readUntilStudio(page, `${dev}-resumed`, { midShot: false });
      await page.waitForSelector('[data-testid="sheet-reader-notice"]', { timeout: 30000 });
      const left = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open('pianovision');
            r.onsuccess = () => {
              const q = r.result.transaction('pending').objectStore('pending').count();
              q.onsuccess = () => resolve(q.result);
            };
          }),
      );
      check(`${dev}: Try again read the kept photo (and the copy is gone)`, /\/studio\//.test(page.url()) && left === 0, { left });
    }

    // ---- library and accuracy page
    await page.goto(base + '/library');
    await page.getByText('Beta', { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(600);
    check(`${dev}: Library cards show Beta on the read songs`, (await page.getByText('Beta', { exact: true }).count()) >= 2 && (await page.getByText('Photo', { exact: true }).count()) > 0 && (await page.getByText('PDF', { exact: true }).count()) > 0);
    await shot(page, `${dev}-library`);
    await page.getByRole('button', { name: 'List view' }).click();
    await page.waitForTimeout(400);
    check(`${dev}: Library list says what they were read from`, (await page.getByText(/Read from a photo/).count()) > 0 && (await page.getByText(/Read from a PDF/).count()) > 0);
    await shot(page, `${dev}-library-list`);
    await page.getByRole('button', { name: 'Grid view' }).click().catch(() => undefined);
    await page.goto(base + '/accuracy#sheet-reader');
    await page.getByText('Sheet music from PDFs and photos').waitFor();
    await page.waitForTimeout(800);
    await shot(page, `${dev}-accuracy`);
    check(`${dev}: Accuracy page has the sheet-reader section in view`, await page.evaluate(() => {
      const r = document.getElementById('sheet-reader').getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0;
    }));
    check(`${dev}: accuracy page has no sideways scroll`, (await sideScroll(page)) <= 0);

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
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
