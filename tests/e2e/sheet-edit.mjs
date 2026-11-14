/**
 * Editing the sheet music, end to end, in Playwright Chromium on a production build served with the
 * exact netlify.toml headers (tests/e2e/isolation.server.py). The demo (J. S. Bach, public domain)
 * and synthetic MIDI made here; no other music.
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/sheet-edit.mjs --dist /tmp/p2v-dist [--port 5740] [--shots DIR] [--only desktop,video,phone,landscape,perf]
 *
 * desktop (1280×800): crossOriginIsolated; without Edit the sheet is as before (no tools, a click on a
 *   note jumps there and changes nothing); E → edit bar; ? opens Help with the shortcut list; keys
 *   change a note (↑, fingering 3, staccato, f) and the key (D major); MusicXML, MIDI (note + key
 *   signature event) and PDF downloads carry the edits; the piano roll shows the edited note with its
 *   fingering; reload keeps everything; Undo brings back the original MusicXML.
 * video: a synthetic two-hand song exported as a video (WebM), then every note moved to the left hand on
 *   the sheet and exported again with a title page: the decoded frames (ffmpeg) show only left-hand
 *   colors.
 * phone (iPhone 14, 390×664, touch): the dock with Notes / Marks / Bar, every button ≥ 44 px, no
 *   sideways scroll; a swipe scrolls and edits nothing; a pinch zooms (and edits nothing); a tap
 *   selects and ▲ changes the pitch; a long press opens the action sheet (finger 2); Add + a tap places
 *   a note and the message's Undo takes it back; Select more adds a second note; full screen keeps the
 *   dock; Help lists the touch gestures.
 * landscape (iPhone 14 sideways, 750×340): the tools are a side rail, the music keeps its width and
 *   height; in full screen a tap selects and ▲ edits.
 * perf: a 5½-minute synthetic Hard song: first drawing, then each edit's key press → on screen time,
 *   at full speed and with the CPU slowed 4× (a phone), and how many chunks were redrawn.
 * Every page: no console errors and no CSP violations. Screenshots: m3-*.png in --shots.
 */
import { spawn, execFileSync } from 'node:child_process';
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
const dist = opt('dist');
const port = Number(opt('port', '5740'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheet-edit-')));
const only = new Set((opt('only', 'desktop,video,phone,landscape,perf') ?? '').split(','));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/sheet-edit.mjs --dist BUILD_DIR [--port N] [--shots DIR] [--only parts]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheet-edit-work-'));
const { chromium, devices } = await import('playwright');
const { Midi } = require('@tonejs/midi');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const results = [];
let failed = false;
const check = (name, ok, info) => {
  results.push({ name, ok, info });
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
};

/** A made-up piece: `bars` bars of 4/4 at 120 BPM, right-hand 8ths, left-hand quarters. */
function synthMidi(file, bars) {
  const midi = new Midi();
  midi.header.setTempo(120);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  midi.header.update();
  const rh = midi.addTrack();
  rh.name = 'Right Hand';
  const lh = midi.addTrack();
  lh.name = 'Left Hand';
  const scale = [0, 2, 4, 5, 7, 9, 11, 12];
  for (let bar = 0; bar < bars; bar++) {
    for (let i = 0; i < 8; i++) rh.addNote({ midi: 67 + scale[(i + bar) % 8], time: bar * 2 + i * 0.25, duration: 0.24, velocity: 0.7 });
    for (let i = 0; i < 4; i++) lh.addNote({ midi: 48 + scale[(i * 2 + bar) % 5], time: bar * 2 + i * 0.5, duration: 0.48, velocity: 0.6 });
  }
  fs.writeFileSync(file, Buffer.from(midi.toArray()));
}

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}
const browser = await chromium.launch();

async function newPage(opts = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...opts });
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
const clean = async (page, errors, what) => {
  const csp = await page.evaluate(() => window.__csp);
  check(`${what}: crossOriginIsolated, no console errors, no CSP violations`, (await page.evaluate(() => crossOriginIsolated)) === true && errors.length === 0 && csp.length === 0, { errors: errors.slice(0, 5), csp: csp.slice(0, 5) });
};

const drawnCount = (page) => page.evaluate(() => performance.getEntriesByName('sheet:all-chunks').length + performance.getEntriesByName('sheet:edit-done').length);
const sheetReady = (page) => page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 90000 });
async function redrawn(page, before) {
  await page.waitForFunction((n) => performance.getEntriesByName('sheet:all-chunks').length + performance.getEntriesByName('sheet:edit-done').length > n, before, { timeout: 30000 });
  await page.waitForTimeout(150);
}
/** Runs an action that changes the sheet and waits for its redraw. */
async function edit(page, fn) {
  const n = await drawnCount(page);
  await fn();
  await redrawn(page, n);
}
const songId = (page) => new URL(page.url()).pathname.split('/').pop();
const idbSong = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('pianovision');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const g = r.result.transaction('songs').objectStore('songs').get(id);
          g.onsuccess = () => {
            res(g.result);
            r.result.close();
          };
          g.onerror = () => rej(g.error);
        };
      }),
    id,
  );
/** Polls IndexedDB until `pred(song)` holds (saves run shortly after an edit). */
async function savedWhen(page, id, pred, ms = 8000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < ms) {
    s = await idbSong(page, id);
    if (s && pred(s)) return s;
    await page.waitForTimeout(200);
  }
  return s;
}
/** Drawn noteheads in view (not under a toolbar, toast or dock): note ids and centres. */
const heads = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="sheet-scroll"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-note-ids]')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { ids: e.getAttribute('data-note-ids'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })
      .filter((h) => h.ids && h.y > sc.top + 70 && h.y < sc.bottom - 24 && h.x > sc.left + 8 && h.x < sc.right - 8)
      .filter((h) => !!document.elementFromPoint(h.x, h.y)?.closest('[data-testid="sheet-music"]'));
  });
const headOf = (page, ids) =>
  page.evaluate((ids) => {
    const el = [...document.querySelectorAll('[data-note-ids]')].find((e) => e.getAttribute('data-note-ids') === ids);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { ids, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, ids);
const selectedIds = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('.sheet-sel')].flatMap((e) => (e.getAttribute('data-note-ids') || '').split(',').filter(Boolean)))].sort());
async function download(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), action()]);
  const file = path.join(work, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return file;
}
async function exportItem(page, label) {
  await page.getByRole('button', { name: /Export/ }).last().click();
  await page.getByRole('menuitem', { name: label }).click();
}
const musicXml = async (page) => fs.readFileSync(await download(page, () => exportItem(page, /MusicXML/)), 'utf8');
async function pdfText(file) {
  const fonts = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, standardFontDataUrl: fonts }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) out.push(...(await (await doc.getPage(p)).getTextContent()).items.map((i) => i.str));
  return out;
}
/** Closes the first-export notice and the toasts (so screenshots show the music). */
async function quiet(page) {
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 500 }).catch(() => {});
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 500 }).catch(() => {});
  await page.waitForTimeout(200);
}
const noteOf = (song, level, id) => song.arrangements[level].notes.find((n) => n.id === id);
const cursorX = (page) => page.evaluate(() => document.querySelector('[data-testid="sheet-cursor"]')?.style.transform ?? '');
/** Buttons in the dock or rail smaller than 44 × 44 px. */
const smallButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sheet-edit-dock"] button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.width < 44 || r.height < 44);
      })
      .map((b) => b.getAttribute('aria-label') || b.textContent),
  );
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

// touch input through the browser's own input pipeline (scrolling, pinching and long presses as on a phone)
async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 4, radiusY: 4, force: 1 })) });
}
async function swipe(page, cdp, x, y0, y1, steps = 12) {
  await touch(cdp, 'touchStart', [{ x, y: y0 }]);
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', [{ x, y: y0 + ((y1 - y0) * i) / steps }]);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(500);
}
async function pinch(page, cdp, cx, cy, d0, d1, steps = 10) {
  const pts = (d) => [
    { x: cx - d / 2, y: cy },
    { x: cx + d / 2, y: cy },
  ];
  await touch(cdp, 'touchStart', pts(d0));
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', pts(d0 + ((d1 - d0) * i) / steps));
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', []);
}
async function longPress(page, cdp, x, y) {
  await touch(cdp, 'touchStart', [{ x, y }]);
  await page.waitForTimeout(750);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(300);
}
async function openDemoSheet(page) {
  await page.goto(base + '/');
  await page.getByText('Try the demo').first().click();
  await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
  await page.getByRole('radio', { name: /Sheet music/ }).first().click();
  await sheetReady(page);
  await page.waitForTimeout(800);
  return songId(page);
}

/** Pixels of the right-hand (blue) and left-hand (orange) note colors in a decoded video frame. */
function handPixels(file, t, W, H) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: W * H * 4 });
  let blue = 0;
  let orange = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    const [r, g, b] = [buf[i], buf[i + 1], buf[i + 2]];
    if (b > 150 && b > r + 60 && b > g + 10) blue++;
    else if (r > 170 && g > 90 && r > b + 90 && g > b + 30) orange++;
  }
  return { blue, orange };
}
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', file]).toString());

/** Renders the open song's video in the Export dialog (720p, 30 FPS, WebM) and saves it. */
async function exportVideo(page, name, titlePage) {
  await page.locator('button:has(svg.lucide-film)').first().click();
  const dlg = page.getByRole('dialog', { name: 'Export video' });
  await dlg.waitFor();
  await dlg.getByLabel('Resolution').selectOption({ label: '720p' });
  await dlg.getByLabel('Frame rate').selectOption({ label: '30 FPS' });
  await dlg.getByLabel('Container').selectOption({ label: 'WebM' });
  const sw = dlg.getByRole('switch', { name: 'Add a title page' });
  if ((await sw.getAttribute('aria-checked')) !== String(titlePage)) await sw.click();
  await page.waitForTimeout(300);
  await dlg.getByRole('button', { name: 'Render video' }).click();
  await dlg.getByRole('button', { name: /^Download/ }).waitFor({ timeout: 480000 });
  const [d] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /^Download/ }).click()]);
  const file = path.join(work, name);
  await d.saveAs(file);
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 2000 }).catch(() => {});
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await page.waitForTimeout(300);
  return file;
}

try {
  // ---------------------------------------------------------------- desktop: view as before, edit, export
  if (only.has('desktop')) {
    const { page, errors } = await newPage();
    const id = await openDemoSheet(page);
    const level = 'hard';
    const original = await idbSong(page, id);
    const xml0 = await musicXml(page);

    // Edit off: the sheet is for reading, a click jumps there and changes nothing
    const hs0 = await heads(page);
    const far = hs0[Math.floor(hs0.length * 0.7)];
    const cur0 = await cursorX(page);
    await page.mouse.click(far.x, far.y);
    await page.waitForTimeout(400);
    const viewOk = (await page.locator('[data-testid="sheet-edit-bar"]').count()) === 0 && (await page.locator('[data-editing]').count()) === 0 && (await selectedIds(page)).length === 0;
    check('Edit off: no edit tools, a click on a note jumps there and selects nothing', viewOk && (await cursorX(page)) !== cur0, { cur0, cur1: await cursorX(page) });
    const pre = await idbSong(page, id);
    check('Edit off: the song is unchanged (no sheet data)', !('sheet' in pre) && JSON.stringify(pre.arrangements) === JSON.stringify(original.arrangements));

    // the piano roll before any edit, at a note in the second line
    const hs = await heads(page);
    const target = hs.find((h) => !h.ids.includes(',') && h.y > hs[0].y + 120 && noteOf(original, level, Number(h.ids))?.hand === 'R') ?? hs[6];
    const tid = Number(target.ids);
    const before = noteOf(original, level, tid);
    await page.mouse.click(target.x, target.y); // view mode: jump to the note
    await page.getByRole('radio', { name: /Piano roll/ }).click();
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+ArrowLeft'); // a moment before it: the note is still falling
    await page.waitForTimeout(600);
    await quiet(page);
    await page.screenshot({ path: path.join(shots, 'm3-roll-before.png') });
    await page.getByRole('radio', { name: /Sheet music/ }).click();
    await sheetReady(page);
    await page.waitForTimeout(900);

    // Edit on
    await page.keyboard.press('e');
    await page.waitForTimeout(500);
    check('E turns on Edit: the edit bar shows on the sheet', (await page.locator('[data-testid="sheet-edit-bar"]').count()) === 1 && (await page.locator('[data-editing="true"]').count()) === 1);
    await page.keyboard.press('Shift+Slash');
    await page.waitForSelector('[data-testid="sheet-help"]');
    const keyRows = await page.locator('[data-testid="sheet-help-keys"] kbd').count();
    await page.screenshot({ path: path.join(shots, 'm3-help.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('? opens Help with the keyboard shortcuts; Esc closes it', keyRows >= 25 && (await page.locator('[data-testid="sheet-help"]').count()) === 0, { keyRows });

    // edit one note: ↑, finger 3, staccato; then f (dynamics picker) and D major (key picker)
    const t1 = await headOf(page, String(tid));
    await page.mouse.click(t1.x, t1.y);
    await page.waitForTimeout(150);
    let steps = 0;
    for (const k of ['ArrowUp', '3', 's']) {
      await edit(page, () => page.keyboard.press(k));
      steps++;
    }
    await page.keyboard.press('d');
    await page.waitForSelector('[data-testid="sheet-dyn-picker"]');
    await edit(page, () => page.locator('[data-testid="sheet-dyn-picker"] [data-dyn="f"]').click());
    steps++;
    await page.keyboard.press('k');
    await page.waitForSelector('[data-testid="sheet-key-picker"]');
    await page.selectOption('[data-testid="sheet-key-select"]', '2|major');
    await edit(page, () => page.getByTestId('sheet-key-apply').click());
    steps++;
    let s = await savedWhen(page, id, (x) => noteOf(x, level, tid)?.finger === 3 && noteOf(x, level, tid)?.art?.includes('staccato') && !!x.sheet?.keys?.length && (x.arrangements[level].marks ?? []).some((m) => m.kind === 'dyn'));
    const up = noteOf(s, level, tid);
    check('keys edit the note on the sheet (↑, finger 3, staccato) and add f and D major', up.midi > before.midi && up.finger === 3 && up.art?.includes('staccato') && s.sheet.keys[0].fifths === 2, { before: before.midi, after: up.midi, finger: up.finger, art: up.art, keys: s.sheet?.keys });
    const t2 = await headOf(page, String(tid));
    await page.mouse.click(t2.x, t2.y);
    await page.waitForTimeout(300);
    await quiet(page);
    await page.screenshot({ path: path.join(shots, 'm3-desktop-edit.png') });
    await page.screenshot({ path: path.join(shots, 'm3-markings-closeup.png'), clip: { x: Math.max(0, t2.x - 260), y: Math.max(0, t2.y - 150), width: 520, height: 300 } });

    // exports carry the edits
    const xml1 = await musicXml(page);
    check('MusicXML download: fingering 3, staccato, f and the key change', /<fingering[^>]*>3<\/fingering>/.test(xml1) && /<staccato/.test(xml1) && /<dynamics>\s*<f\/>/.test(xml1) && /<fifths>2<\/fifths>/.test(xml1));
    const midiFile = await download(page, () => exportItem(page, /MIDI file/));
    const midi = new Midi(fs.readFileSync(midiFile));
    const mn = midi.tracks.flatMap((t) => t.notes);
    check('MIDI download: the edited pitch, every note, and a D major key signature', mn.length === s.arrangements[level].notes.length && mn.some((m) => m.midi === up.midi && Math.abs(m.time - up.start) < 0.01) && midi.header.keySignatures.some((k) => k.key === 'D' && k.scale === 'major'), { notes: mn.length, keys: midi.header.keySignatures });
    await exportItem(page, /Sheet music PDF/);
    const pdfFile = await download(page, () => page.getByRole('button', { name: 'Download PDF' }).click());
    const words = await pdfText(pdfFile);
    check('PDF download: the fingering 3 and the f are in its text', words.some((w) => w.trim() === '3') && words.some((w) => w.trim() === 'f'), { n: words.length });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // the piano roll follows: the note moved and shows its finger number (Edit off, as before)
    await page.keyboard.press('e');
    await page.waitForTimeout(300);
    const t3 = await headOf(page, String(tid));
    await page.mouse.click(t3.x, t3.y);
    await page.getByRole('radio', { name: /Piano roll/ }).click();
    await page.waitForTimeout(600);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.waitForTimeout(600);
    await quiet(page);
    await page.screenshot({ path: path.join(shots, 'm3-roll-after.png') });
    const a = fs.readFileSync(path.join(shots, 'm3-roll-before.png'));
    const b = fs.readFileSync(path.join(shots, 'm3-roll-after.png'));
    check('piano roll: it looks different after the sheet edits (the edited note, its finger number)', !a.equals(b));
    await page.getByRole('radio', { name: /Sheet music/ }).click();
    await sheetReady(page);
    await page.waitForTimeout(800);

    // reload keeps the edits
    await page.reload();
    await page.waitForURL(/\/studio\/.+/);
    await sheetReady(page);
    await page.waitForTimeout(1000);
    const xml2 = await musicXml(page);
    check('reload: the edits are kept (same MusicXML)', xml2 === xml1);
    await clean(page, errors, 'desktop');
    await page.context().close();

    // undo (the history is per visit): a fresh demo, four edits, four Ctrl+Z
    const p2 = await newPage();
    const id2 = await openDemoSheet(p2.page);
    const xmlA = await musicXml(p2.page);
    await p2.page.keyboard.press('e');
    await p2.page.waitForTimeout(300);
    const h2 = (await heads(p2.page)).find((h) => !h.ids.includes(','));
    await p2.page.mouse.click(h2.x, h2.y);
    for (const k of ['ArrowUp', '4', 'a', 'BracketRight']) await edit(p2.page, () => p2.page.keyboard.press(k));
    await savedWhen(p2.page, id2, (x) => !!x.sheet);
    for (let i = 0; i < 4; i++) {
      await p2.page.keyboard.press('Control+z');
      await p2.page.waitForTimeout(150);
    }
    await savedWhen(p2.page, id2, (x) => !x.sheet);
    await p2.page.waitForTimeout(1200);
    check('Ctrl+Z undoes every edit: the MusicXML is the original again', (await musicXml(p2.page)) === xmlA && xmlA === xml0);
    await clean(p2.page, p2.errors, 'desktop undo');
    await p2.ctx.close();
  }

  // ---------------------------------------------------------------- video export follows sheet edits
  if (only.has('video')) {
    const { page, errors } = await newPage({ viewport: { width: 1400, height: 900 } });
    const file = path.join(work, 'synthetic-4-bars.mid');
    synthMidi(file, 4);
    await page.goto(base + '/import?tab=midi');
    await page.setInputFiles('input[type=file]', file);
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const id = songId(page);
    await page.waitForTimeout(800);
    const v1 = await exportVideo(page, 'before.webm', false);
    const view = page.getByRole('radio', { name: /Sheet music/ });
    await view.click();
    await sheetReady(page);
    await page.waitForTimeout(600);
    await page.keyboard.press('e');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+a');
    await edit(page, () => page.keyboard.press('l'));
    const s = await savedWhen(page, id, (x) => Object.values(x.arrangements).some((a) => a.notes.length && a.notes.every((n) => n.hand === 'L')));
    check('sheet: Ctrl+A then L moves every note to the left hand', !!s);
    await page.keyboard.press('e');
    await page.waitForTimeout(300);
    const v2 = await exportVideo(page, 'after.webm', true);
    const p1 = probe(v1);
    const p2 = probe(v2);
    const d1 = Number(p1.format.duration);
    const d2 = Number(p2.format.duration);
    const { width: W, height: H } = p1.streams[0];
    // the same song moment in both (the second one starts with a title page): counted from the end
    const at = [3, 4.5, 6];
    const before = at.map((x) => handPixels(v1, d1 - x, W, H));
    const after = at.map((x) => handPixels(v2, d2 - x, W, H));
    const sum = (l, k) => l.reduce((n, p) => n + p[k], 0);
    check(
      'video: before the edit both hand colors show; after it (with a title page) only the left hand',
      sum(before, 'blue') > 2000 && sum(before, 'orange') > 2000 && sum(after, 'blue') < sum(before, 'blue') * 0.05 && sum(after, 'orange') > sum(before, 'orange') && d2 > d1 + 1,
      { before, after, d1, d2, codec: p2.streams[0].codec_name },
    );
    await clean(page, errors, 'video');
    await page.context().close();
  }

  // ---------------------------------------------------------------- iPhone 14, portrait
  if (only.has('phone')) {
    const { ctx, page, errors } = await newPage({ ...devices['iPhone 14'] });
    const cdp = await ctx.newCDPSession(page);
    const id = await openDemoSheet(page);
    const original = await idbSong(page, id);
    const count0 = original.arrangements.hard.notes.length;
    await page.getByRole('button', { name: /^Edit/ }).first().tap();
    await page.waitForTimeout(700);
    const dock = page.locator('[data-testid="sheet-edit-dock"]:not([inert])');
    const layout = await dock.getAttribute('data-layout');
    const small = [];
    for (const tb of ['notes', 'marks', 'bar']) {
      await page.getByTestId(`sheet-tab-${tb}`).tap();
      await page.waitForTimeout(150);
      small.push(...(await smallButtons(page)));
    }
    await page.getByTestId('sheet-tab-notes').tap();
    check('phone: the dock (Notes / Marks / Bar) shows; every button ≥ 44 × 44 px; no sideways scroll', layout === 'dock' && small.length === 0 && !(await overflowX(page)), { layout, small });

    // a swipe scrolls the music and edits nothing
    const sc = await page.locator('[data-testid="sheet-scroll"]').boundingBox();
    const top0 = await page.evaluate(() => document.querySelector('[data-testid="sheet-scroll"]').scrollTop);
    await swipe(page, cdp, sc.x + sc.width / 2, sc.y + sc.height * 0.8, sc.y + sc.height * 0.25);
    const top1 = await page.evaluate(() => document.querySelector('[data-testid="sheet-scroll"]').scrollTop);
    await page.waitForTimeout(900);
    let s = await idbSong(page, id);
    check('phone: a swipe scrolls the sheet; nothing is selected or changed', top1 > top0 + 50 && (await selectedIds(page)).length === 0 && !s.sheet && s.arrangements.hard.notes.length === count0, { top0, top1 });
    await page.evaluate(() => (document.querySelector('[data-testid="sheet-scroll"]').scrollTop = 0));
    await page.waitForTimeout(300);

    // a pinch zooms (no tap, no edit)
    const zoomText = () => page.locator('[data-testid="sheet-toolbar"] button[title="Reset size"]').innerText();
    const z0 = await zoomText();
    let n = await drawnCount(page);
    await pinch(page, cdp, sc.x + sc.width / 2, sc.y + sc.height * 0.6, 80, 125);
    await redrawn(page, n).catch(() => {});
    await page.waitForTimeout(600);
    const z1 = await zoomText();
    s = await idbSong(page, id);
    check('phone: two fingers pinch the music bigger; nothing is selected or changed', parseInt(z1) > parseInt(z0) && (await selectedIds(page)).length === 0 && !s.sheet, { z0, z1 });

    // tap selects; ▲ changes the pitch
    let hs = await heads(page);
    const h = hs.find((x) => !x.ids.includes(',') && noteOf(original, 'hard', Number(x.ids))?.hand === 'R') ?? hs[2];
    const hid = Number(h.ids);
    await page.touchscreen.tap(h.x, h.y);
    await page.waitForTimeout(300);
    const sel = await selectedIds(page);
    await edit(page, () => page.getByTestId('sheet-up').tap());
    s = await savedWhen(page, id, (x) => noteOf(x, 'hard', hid)?.midi > noteOf(original, 'hard', hid).midi);
    check('phone: a tap selects the note; ▲ moves it up a step', JSON.stringify(sel) === JSON.stringify([h.ids]) && noteOf(s, 'hard', hid).midi > noteOf(original, 'hard', hid).midi, { sel, want: h.ids });
    await page.screenshot({ path: path.join(shots, 'm3-phone-palette.png') });

    // long press: the action sheet; finger 2
    const hp = await headOf(page, String(hid));
    await longPress(page, cdp, hp.x, hp.y);
    const sheetOpen = (await page.locator('[data-testid="sheet-actions"]').count()) === 1;
    await page.screenshot({ path: path.join(shots, 'm3-phone-actions.png') });
    const actSmall = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="sheet-actions"] button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      }).length,
    );
    if (sheetOpen) await edit(page, () => page.getByTestId('sheet-act-finger-2').tap());
    s = await savedWhen(page, id, (x) => noteOf(x, 'hard', hid)?.finger === 2);
    check('phone: a long press opens the action sheet (big buttons); Fingering 2 sets it', sheetOpen && actSmall === 0 && noteOf(s, 'hard', hid)?.finger === 2, { sheetOpen, actSmall });

    // Add + a tap places a note; Undo in the message takes it back
    const c1 = s.arrangements.hard.notes.length;
    await page.getByTestId('sheet-add').tap();
    await page.waitForTimeout(200);
    const banner = (await page.locator('[data-testid="sheet-add-banner"]').count()) === 1;
    hs = await heads(page);
    const ref = hs.find((x) => !x.ids.includes(',') && noteOf(s, 'hard', Number(x.ids))?.hand === 'R') ?? hs[0];
    const spot = await page.evaluate(
      ({ y, x }) => {
        const all = [...document.querySelectorAll('[data-note-ids]')].map((e) => e.getBoundingClientRect());
        for (let dx = 14; dx < 300; dx += 4) for (const sx of [x + dx, x - dx]) if (sx > 30 && sx < innerWidth - 20 && !all.some((r) => Math.abs(r.left + r.width / 2 - sx) < 22 && Math.abs(r.top + r.height / 2 - y) < 40)) return sx;
        return null;
      },
      { y: ref.y, x: ref.x },
    );
    const tTap = Date.now();
    await edit(page, () => page.touchscreen.tap(spot, ref.y));
    const addedShown = (await page.locator('[data-testid="sheet-added"]').count()) === 1;
    const addedText = addedShown ? await page.getByTestId('sheet-added').innerText() : '';
    console.log(`   added message after ${Date.now() - tTap} ms: ${addedShown}`);
    await page.screenshot({ path: path.join(shots, 'm3-phone-added.png') });
    const idsOf = (x) => x.arrangements.hard.notes.map((n) => n.id).join(',');
    const ids1 = idsOf(s);
    s = await savedWhen(page, id, (x) => idsOf(x) !== ids1, 4000);
    const c2 = s.arrangements.hard.notes.length;
    const stillShown = (await page.locator('[data-testid="sheet-added-undo"]').count()) === 1;
    console.log(`   after the save (${Date.now() - tTap} ms): ${c1} -> ${c2} notes, message shown: ${stillShown}`);
    if (stillShown) await edit(page, () => page.getByTestId('sheet-added-undo').tap());
    // (the new note can replace a same-pitch note it covers: count the new ids, not the notes)
    const had = new Set(ids1.split(','));
    const fresh = idsOf(s).split(',').filter((x) => !had.has(x));
    s = await savedWhen(page, id, (x) => idsOf(x) === ids1);
    check('phone: Add + a tap places one note ("Added …"); its Undo takes it back', banner && addedShown && stillShown && fresh.length === 1 && idsOf(s) === ids1, { banner, addedText, c1, c2, fresh, back: idsOf(s) === ids1 });
    await page.getByTestId('sheet-add').tap();
    await page.waitForTimeout(200);

    // Select more: a second tap adds to the selection
    hs = await heads(page);
    const singles = hs.filter((x) => !x.ids.includes(','));
    await page.touchscreen.tap(singles[1].x, singles[1].y);
    await page.waitForTimeout(250);
    await page.getByTestId('sheet-select-more').tap();
    await page.touchscreen.tap(singles[3].x, singles[3].y);
    await page.waitForTimeout(300);
    const two = await selectedIds(page);
    const status = await page.getByTestId('sheet-status').innerText();
    await page.getByTestId('sheet-select-more').tap();
    check('phone: Select more: a second tap adds to the selection', two.length === 2 && /2 notes/.test(status), { two, status });

    // Marks tab close-up, Help, full screen
    await page.getByTestId('sheet-tab-marks').tap();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, 'm3-phone-marks.png') });
    await page.getByTestId('sheet-help-open').first().tap();
    await page.waitForSelector('[data-testid="sheet-help"]');
    const helpTouch = await page.getByTestId('sheet-help').innerText();
    await page.getByRole('button', { name: 'Close' }).first().tap();
    await page.waitForTimeout(300);
    check('phone: Help lists the touch gestures first', /On a phone or tablet[\s\S]*Mouse and keyboard/i.test(helpTouch) && /Press and hold/.test(helpTouch));
    await page.getByRole('button', { name: 'Full screen' }).first().tap();
    await page.waitForTimeout(1000);
    const fsDock = await page.locator('[data-testid="sheet-edit-dock"]:not([inert])').boundingBox();
    await page.screenshot({ path: path.join(shots, 'm3-phone-fullscreen.png') });
    check('phone: full screen keeps Edit mode with the dock at the bottom', !!fsDock && fsDock.y + fsDock.height <= 664 + 1 && fsDock.y > 300 && !(await overflowX(page)), { fsDock });
    await clean(page, errors, 'phone');
    await ctx.close();
  }

  // ---------------------------------------------------------------- iPhone 14, sideways
  if (only.has('landscape')) {
    const { ctx, page, errors } = await newPage({ ...devices['iPhone 14 landscape'] });
    const id = await openDemoSheet(page);
    const original = await idbSong(page, id);
    await page.getByRole('button', { name: /^Edit/ }).first().tap();
    await page.waitForTimeout(700);
    const dock = page.locator('[data-testid="sheet-edit-dock"]:not([inert])');
    const layout = await dock.getAttribute('data-layout');
    const small = await smallButtons(page);
    await page.getByTestId('sheet-rail-fullscreen').tap();
    await page.waitForTimeout(1200);
    const sc = await page.locator('[data-testid="sheet-scroll"]').boundingBox();
    const rail = await dock.boundingBox();
    const hs = await heads(page);
    const h = hs.find((x) => !x.ids.includes(',')) ?? hs[0];
    const hid = Number(h.ids);
    await page.touchscreen.tap(h.x, h.y);
    await page.waitForTimeout(300);
    await edit(page, () => page.getByTestId('sheet-up').tap());
    const s = await savedWhen(page, id, (x) => noteOf(x, 'hard', hid)?.midi > noteOf(original, 'hard', hid).midi);
    await page.screenshot({ path: path.join(shots, 'm3-phone-landscape.png') });
    check(
      'sideways: the tools are a side rail (buttons ≥ 44 px); in full screen the music keeps most of the screen; tap + ▲ edits',
      layout === 'rail' && small.length === 0 && sc.width >= 380 && sc.height >= 280 && rail.x >= sc.x + sc.width - 1 && noteOf(s, 'hard', hid).midi > noteOf(original, 'hard', hid).midi && !(await overflowX(page)),
      { layout, small, sc, rail },
    );
    await clean(page, errors, 'sideways');
    await ctx.close();
  }

  // ---------------------------------------------------------------- a long song: how fast edits show
  if (only.has('perf')) {
    const { ctx, page, errors } = await newPage();
    const file = path.join(work, 'synthetic-165-bars.mid');
    synthMidi(file, 165); // 5 min 30 s
    await page.goto(base + '/import?tab=midi');
    await page.setInputFiles('input[type=file]', file);
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    await page.getByRole('radio', { name: /hard/i }).click();
    const t0 = Date.now();
    const view = page.getByRole('radio', { name: /Sheet music/ });
    if ((await view.getAttribute('aria-checked')) !== 'true') await view.click();
    await sheetReady(page);
    const firstMs = Date.now() - t0;
    await page.waitForFunction(() => performance.getEntriesByName('sheet:all-chunks').length > 0, null, { timeout: 120000 });
    const allMs = Date.now() - t0;
    await page.keyboard.press('e');
    await page.waitForTimeout(800);
    const chunks = await page.locator('.sheet-chunk').count();
    const measure = async (keys) => {
      const out = [];
      for (const key of keys) {
        await page.evaluate(() => {
          window.__k = 0;
          window.addEventListener('keydown', () => (window.__k = performance.now()), { capture: true, once: true });
        });
        const n = await drawnCount(page);
        await page.keyboard.press(key);
        await redrawn(page, n);
        out.push(
          await page.evaluate(() => {
            const done = performance.getEntriesByName('sheet:edit-done').at(-1)?.startTime ?? 0;
            return { ms: Math.round(done - window.__k), redrawn: Number(document.querySelector('[data-redrawn]')?.getAttribute('data-redrawn') ?? -1), status: document.querySelector('[data-testid="sheet-status"]')?.textContent };
          }),
        );
      }
      return out;
    };
    const keys = ['ArrowUp', 'ArrowDown', 'BracketRight', 'BracketLeft', '3', 's', 's', '0'];
    let hs = await heads(page);
    await page.mouse.click(hs[3].x, hs[3].y);
    await page.waitForTimeout(200);
    const fast = await measure(keys);
    // the middle of the song
    await page.evaluate(() => {
      const sc = document.querySelector('[data-testid="sheet-scroll"]');
      sc.scrollTop = sc.scrollHeight / 2;
    });
    await page.waitForTimeout(800);
    hs = await heads(page);
    await page.mouse.click(hs[2].x, hs[2].y);
    await page.waitForTimeout(200);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const slow = await measure(keys);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const stats = (l) => {
      const ms = l.map((x) => x.ms).sort((a, b) => a - b);
      return { median: ms[Math.floor(ms.length / 2)], max: ms.at(-1), redrawn: [...new Set(l.map((x) => x.redrawn))] };
    };
    console.log("   per key", JSON.stringify(keys.map((k, i) => [k, fast[i], slow[i]])));
    const f = stats(fast);
    const sl = stats(slow);
    console.log(`   long song (165 bars, 5:30, Hard, ${chunks} chunks): first lines ${firstMs} ms, all ${allMs} ms; edits ${JSON.stringify(f)}, CPU ÷4 ${JSON.stringify(sl)}`);
    check('5½-minute song: each edit is on screen within 300 ms (median under 150 ms), one chunk redrawn', f.max < 300 && f.median < 150 && f.redrawn.every((r) => r <= 1) && f.redrawn.includes(1), { firstMs, allMs, chunks, fast: f });
    // (0 chunks: an edit that doesn't change the drawing, such as ] on a note the next same-pitch note cuts short)
    check('5½-minute song, CPU slowed 4× (a phone): each edit within 1 s, at most one chunk redrawn', sl.max < 1000 && sl.redrawn.every((r) => r <= 1) && sl.redrawn.includes(1), { slow: sl });
    await page.screenshot({ path: path.join(shots, 'm3-long-song.png') });
    await clean(page, errors, 'long song');
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, shots }));
process.exit(failed ? 1 : 0);
