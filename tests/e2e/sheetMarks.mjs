/**
 * Markings on the sheet music, in Playwright Chromium on a production build served with the exact
 * netlify.toml headers (tests/e2e/isolation.server.py).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/sheetMarks.mjs --dist /tmp/p2v-dist [--port 5713] [--shots DIR]
 *
 * Desktop 1280×800, the demo (J. S. Bach, public domain; no recording), Hard, by keyboard and mouse:
 * finger 3, staccato, accent, a slur, mf (and f later), a crescendo, the words "dolce", pedal, a key
 * change to D major, a time change to 3/4 and a tempo of 90 (it re-times the music).
 *  - the drawn sheet has the fingering, the dynamics, the words, the tempo mark, the new key and time;
 *  - the MusicXML download has every marking;
 *  - the PDF (Sheet music PDF dialog) has "dolce" and the fingering "3" in its text;
 *  - the tempo mark re-times the music after it (store and MIDI download); MIDI velocities rise
 *    after mf → f;
 *  - a click on a marking selects it (status line) and Delete removes it;
 *  - Undo removes all of it (the original notes and MusicXML again); redo, reload: kept;
 *  - phone 390×844: the dock's Marks and Bar tabs, a tap and a finger number, buttons ≥ 44 px.
 * Screenshots: m2-*.png in --shots (deviceScaleFactor 2).
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
const dist = opt('dist');
const port = Number(opt('port', '5713'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheetmarks-')));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/sheetMarks.mjs --dist BUILD_DIR [--port N] [--shots DIR]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheetmarks-work-'));
const { chromium } = await import('playwright');
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

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();

const drawnCount = (page) => page.evaluate(() => performance.getEntriesByName('sheet:all-chunks').length + performance.getEntriesByName('sheet:edit-done').length);
const sheetReady = (page) => page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
async function redrawn(page, before) {
  await page.waitForFunction((n) => performance.getEntriesByName('sheet:all-chunks').length + performance.getEntriesByName('sheet:edit-done').length > n, before, { timeout: 30000 });
  await page.waitForTimeout(150);
}
/** Runs an action that changes the sheet and waits for the redraw. */
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
/** Drawn noteheads in view: their note ids and centres. */
const heads = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="sheet-scroll"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-note-ids]')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { ids: e.getAttribute('data-note-ids'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })
      .filter((h) => h.ids && h.y > sc.top + 60 && h.y < sc.bottom - 20);
  });
/** Single-note heads of one hand grouped into lines (document order), as note ids. */
const handLines = (page, hand) =>
  page.evaluate((ids) => {
    const set = new Set(ids.map(String));
    const sc = document.querySelector('[data-testid="sheet-scroll"]');
    const top = sc.getBoundingClientRect().top - sc.scrollTop;
    const hs = [...document.querySelectorAll('[data-note-ids]')]
      .map((e) => ({ ids: e.getAttribute('data-note-ids'), r: e.getBoundingClientRect() }))
      .filter((h) => h.ids && !h.ids.includes(',') && set.has(h.ids))
      .map((h) => ({ ids: h.ids, x: h.r.left, y: h.r.top - top }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const h of hs) {
      const l = lines[lines.length - 1];
      if (l && h.y - l[0].y < 90) l.push(h);
      else lines.push([h]);
    }
    return lines.map((l) => l.sort((a, b) => a.x - b.x).map((h) => h.ids));
  }, hand);
/** The centre of a note's head, scrolled into view. */
const headOf = (page, ids) =>
  page.evaluate((ids) => {
    const el = [...document.querySelectorAll('[data-note-ids]')].find((e) => e.getAttribute('data-note-ids') === ids);
    if (!el) return null;
    const r0 = el.getBoundingClientRect();
    const sc = document.querySelector('[data-testid="sheet-scroll"]').getBoundingClientRect();
    if (r0.top < sc.top + 90 || r0.bottom > sc.bottom - 40) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { ids, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, ids);
const svgTexts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="sheet-music"] svg text')].map((t) => (t.textContent ?? '').trim()).filter(Boolean));
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
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    out.push(...tc.items.map((i) => i.str));
  }
  return out;
}
const sameNotes = (a, b) => JSON.stringify(a.map((n) => [n.id, n.midi, n.start, n.dur, n.hand, n.vel])) === JSON.stringify(b.map((n) => [n.id, n.midi, n.start, n.dur, n.hand, n.vel]));
const has = (xml, re) => re.test(xml);

try {
  // ---------------------------------------------------------------- desktop: every marking on the demo
  {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const id = songId(page);
    await page.getByRole('radio', { name: /Sheet music/ }).click();
    await sheetReady(page);
    await page.waitForTimeout(800);
    const original = await idbSong(page, id);
    const level = 'hard';
    const xml0 = await musicXml(page);
    const texts0 = await svgTexts(page);
    await page.keyboard.press('e');
    await page.waitForTimeout(500);

    // single right-hand noteheads of the first line, in reading order (note ids)
    const rIds = original.arrangements[level].notes.filter((n) => n.hand === 'R').map((n) => n.id);
    const lIds = original.arrangements[level].notes.filter((n) => n.hand === 'L').map((n) => n.id);
    const rLines = await handLines(page, rIds);
    const line1 = rLines[0];
    const lh0 = (await handLines(page, lIds))[0][0];
    const click = async (ids, mods) => {
      await page.waitForTimeout(60);
      const h = await headOf(page, ids);
      if (!h) throw new Error(`no notehead for ${ids}`);
      await page.waitForTimeout(60);
      if (mods) await page.keyboard.down(mods);
      await page.mouse.click(h.x, h.y);
      if (mods) await page.keyboard.up(mods);
      await page.waitForTimeout(120);
    };
    let steps = 0;
    const key = async (k) => {
      await edit(page, () => page.keyboard.press(k));
      steps++;
    };
    // finger 3, staccato, accent
    await click(line1[1]);
    await key('3');
    await click(line1[2]);
    await key('s');
    await click(line1[3]);
    await key('a');
    // slur over four notes
    await click(line1[4]);
    await click(line1[7], 'Shift');
    await key('Shift+S');
    // mf on both hands at the start (D, then Enter on the focused mf)
    await click(line1[0]);
    await click(lh0, 'Shift');
    await page.keyboard.press('d');
    await page.waitForSelector('[data-testid="sheet-dyn-picker"]');
    await edit(page, () => page.keyboard.press('Enter'));
    steps++;
    // a crescendo over the second half of the line
    await click(line1[8]);
    await click(line1[line1.length - 1], 'Shift');
    await edit(page, () => page.keyboard.press('Shift+Comma'));
    steps++;
    // words
    await click(line1[2]);
    await page.keyboard.press('w');
    await page.waitForSelector('[data-testid="sheet-text-input"]');
    await page.keyboard.type('dolce');
    await edit(page, () => page.keyboard.press('Enter'));
    steps++;
    // pedal over the first half
    await click(line1[0]);
    await click(line1[6], 'Shift');
    await key('p');
    await page.screenshot({ path: path.join(shots, 'm2-marks-line1.png') });
    let s = await savedWhen(page, id, (x) => (x.arrangements[level].marks?.length ?? 0) >= 4 && x.arrangements[level].showPedal);
    const stOf = (x) => ({ finger: x.arrangements[level].notes.filter((n) => n.finger).map((n) => n.finger), art: x.arrangements[level].notes.filter((n) => n.art).map((n) => n.art.join()), pedalEdited: x.arrangements[level].pedalEdited, showPedal: x.arrangements[level].showPedal });
    const marks = s.arrangements[level].marks ?? [];
    const notes = s.arrangements[level].notes;
    check('store: finger 3, staccato, accent, slur, mf, crescendo, words, pedal', notes.some((n) => n.finger === 3) && notes.some((n) => n.art?.includes('staccato')) && notes.some((n) => n.art?.includes('accent')) && marks.some((m) => m.kind === 'slur') && marks.some((m) => m.kind === 'dyn' && m.value === 'mf' && m.staff === 0) && marks.some((m) => m.kind === 'wedge' && m.dir === 'cresc') && marks.some((m) => m.kind === 'text' && m.text === 'dolce') && s.arrangements[level].pedalEdited === true, { marks: marks.map((m) => m.kind + (m.value ?? m.dir ?? m.text ?? '')), ...stOf(s) });
    const stacc = notes.find((n) => n.art?.includes('staccato'));
    check('staccato plays shorter (dur baked, the length before kept)', stacc.dur < stacc.artBase.dur, { dur: stacc.dur, before: stacc.artBase.dur });

    // f later (second line), so the MIDI velocities rise after it
    const line2 = rLines[1];
    await click(line2[0]);
    await page.getByTestId('sheet-marks-button').click();
    await page.getByTestId('sheet-dyn-open').click();
    await page.waitForSelector('[data-testid="sheet-dyn-picker"]');
    await page.screenshot({ path: path.join(shots, 'm2-marks-popover.png') });
    await edit(page, () => page.locator('[data-testid="sheet-dyn-picker"] [data-dyn="f"]').click());
    steps++;
    await page.getByTestId('sheet-marks-button').click();
    await page.waitForTimeout(150);

    // bar tools: D major from the second line, 3/4 later, then tempo 90 from the third bar of 3/4
    const ids2 = Number(line2[0]);
    await click(line2[0]);
    await page.keyboard.press('k');
    await page.waitForSelector('[data-testid="sheet-key-picker"]');
    await page.selectOption('[data-testid="sheet-key-select"]', '2|major');
    await edit(page, () => page.getByTestId('sheet-key-apply').click());
    steps++;
    const line3 = rLines[2];
    await click(line3[0]);
    await page.keyboard.press('m');
    await page.waitForSelector('[data-testid="sheet-time-picker"]');
    await page.getByTestId('sheet-time-3-4').click();
    await edit(page, () => page.getByTestId('sheet-time-apply').click());
    steps++;
    const before = await savedWhen(page, id, (x) => x.sheet?.meters?.length);
    // the bar after the 3/4 change (line breaks may move: find the note again)
    await click(rLines[3][0]);
    await page.keyboard.press('Shift+T');
    await page.waitForSelector('[data-testid="sheet-tempo-picker"]');
    await page.getByTestId('sheet-tempo-bpm').fill('90');
    const changeSpeed = await page.getByTestId('sheet-tempo-change').isChecked();
    await page.screenshot({ path: path.join(shots, 'm2-tempo-picker.png') });
    await edit(page, () => page.getByTestId('sheet-tempo-apply').click());
    steps++;
    s = await savedWhen(page, id, (x) => x.sheet?.tempos?.length);
    const tm = s.sheet.tempos[0];
    check('tempo 90 (no recording): "Change playback speed" is on and the music is re-timed', changeSpeed && tm.bpm === 90 && tm.retimed === true && s.duration < before.duration - 1, { tm, before: before.duration, after: s.duration });
    // seconds before the tempo mark are unchanged, after it faster (66 → 90)
    const t0 = tm.pos; // divisions
    const byId = new Map(before.arrangements[level].notes.map((n) => [n.id, n]));
    let same = 0;
    let faster = 0;
    let total = 0;
    const startPos = before.sheet.grid; // only for the log
    void startPos;
    const gapsBefore = [];
    const gapsAfter = [];
    const after = s.arrangements[level].notes.filter((n) => byId.has(n.id)).sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < after.length; i++) {
      const a = after[i];
      const b = after[i + 1];
      const oa = byId.get(a.id);
      const ob = byId.get(b.id);
      const g0 = ob.start - oa.start;
      const g1 = b.start - a.start;
      if (g0 <= 0.01) continue;
      total++;
      if (Math.abs(g1 - g0) < 1e-6) same++;
      else if (Math.abs(g1 / g0 - 66 / 90) < 0.02) faster++;
      (Math.abs(g1 - g0) < 1e-6 ? gapsBefore : gapsAfter).push(g1 / g0);
    }
    check('the notes after the tempo mark play 66/90 as far apart; those before it are unchanged', same > 20 && faster > 100 && same + faster >= total - 2, { same, faster, total, t0 });
    await page.screenshot({ path: path.join(shots, 'm2-key-time-tempo.png') });

    // the drawn sheet
    const texts = await svgTexts(page);
    const n3 = (arr) => arr.filter((t) => t === '3').length;
    check('drawn: fingering 3, mf and f, the words "dolce", the tempo mark', n3(texts) > n3(texts0) && texts.includes('mf') && texts.includes('f') && texts.includes('dolce') && texts.some((t) => /=\s*90/.test(t)), { threes: [n3(texts0), n3(texts)], some: texts.filter((t) => !/^\d+$/.test(t)).slice(0, 12) });

    // MusicXML download
    const xml = await musicXml(page);
    const want = {
      fingering: /<fingering placement="above">3<\/fingering>/,
      staccato: /<staccato\/>/,
      accent: /<accent\/>/,
      slur: /<slur type="start"[^>]*\/>[\s\S]*<slur type="stop"/,
      mf: /<dynamics><mf\/><\/dynamics>/,
      f: /<dynamics><f\/><\/dynamics>/,
      crescendo: /<wedge type="crescendo"/,
      words: /<words font-style="italic">dolce<\/words>/,
      pedal: /<pedal type="start"/,
      key: /<key>(<cancel>-?\d<\/cancel>)?<fifths>2<\/fifths><mode>major<\/mode><\/key>/,
      time: /<time><beats>3<\/beats><beat-type>4<\/beat-type><\/time>/,
      tempo: /<per-minute>90<\/per-minute><\/metronome><\/direction-type><staff>1<\/staff><sound tempo="90"\/>/,
    };
    const missing = Object.entries(want).filter(([, re]) => !has(xml, re)).map(([k]) => k);
    check('MusicXML download has every marking', !missing.length, { missing });

    // PDF
    await exportItem(page, /Sheet music PDF/);
    const pdfFile = await download(page, () => page.getByRole('button', { name: 'Download PDF' }).click());
    const words = await pdfText(pdfFile);
    check('PDF text has "dolce" and the fingering "3" (and the dynamics)', words.some((w) => w.includes('dolce')) && words.filter((w) => w.trim() === '3').length >= 1 && words.some((w) => w.trim() === 'mf'), { n: words.length, sample: words.filter((w) => /[a-z]/.test(w)).slice(0, 10) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // MIDI: velocities rise after mf → f; notes follow the new tempo
    const midiFile = await download(page, () => exportItem(page, /MIDI file/));
    const midiNotes = new Midi(fs.readFileSync(midiFile)).tracks.flatMap((t) => t.notes);
    const fNote = s.arrangements[level].notes.find((n) => n.id === ids2);
    const rhMidi = (lo, hi) => {
      const v = midiNotes.filter((m) => m.time >= lo - 1e-3 && m.time < hi - 1e-3 && s.arrangements[level].notes.some((n) => n.hand === 'R' && Math.abs(n.start - m.time) < 0.002 && n.midi === m.midi)).map((m) => m.velocity);
      return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
    };
    const vMf = rhMidi(0, fNote.start);
    const vF = rhMidi(fNote.start, fNote.start + 6);
    check('MIDI download: velocities rise after mf → f', vF > vMf + 0.05, { mf: vMf.toFixed(3), f: vF.toFixed(3) });
    check('MIDI download: the notes follow the re-timed music', midiNotes.length === s.arrangements[level].notes.length && Math.abs(Math.max(...midiNotes.map((m) => m.time + m.duration)) - Math.max(...s.arrangements[level].notes.map((n) => n.start + n.dur))) < 0.01);

    // a click on a marking selects it; Delete removes it (then undo puts it back)
    const dolce = await page.evaluate(() => {
      const t = [...document.querySelectorAll('[data-testid="sheet-music"] svg text')].find((e) => e.textContent?.trim() === 'dolce');
      t?.scrollIntoView({ block: 'center' });
      const r = t?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (dolce) {
      await page.waitForTimeout(200);
      await page.mouse.click(dolce.x, dolce.y);
      await page.waitForTimeout(200);
    }
    const status = await page.getByTestId('sheet-status').innerText();
    await page.screenshot({ path: path.join(shots, 'm2-mark-selected.png') });
    console.log('status after clicking the words:', status);
    await edit(page, () => page.keyboard.press('Delete'));
    s = await savedWhen(page, id, (x) => !x.arrangements[level].marks?.some((m) => m.kind === 'text'));
    check('a click on the words selects them; Delete removes them', !!dolce && /dolce/.test(status) && !s.arrangements[level].marks.some((m) => m.kind === 'text'), { status });
    await edit(page, () => page.keyboard.press('Control+z'));
    s = await savedWhen(page, id, (x) => x.arrangements[level].marks?.some((m) => m.kind === 'text'));
    const full = s;
    const xmlFull = await musicXml(page);

    // undo all of it
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(100);
    }
    s = await savedWhen(page, id, (x) => !x.sheet && sameNotes(x.arrangements[level].notes, original.arrangements[level].notes));
    check('Undo removes every marking (notes, velocities, seconds and pedal as before, no sheet data)', !s.sheet && !s.arrangements[level].marks && !s.arrangements[level].showPedal && sameNotes(s.arrangements[level].notes, original.arrangements[level].notes) && JSON.stringify(s.arrangements[level].pedal) === JSON.stringify(original.arrangements[level].pedal) && s.duration === original.duration, { steps });
    await page.waitForTimeout(1500);
    check('after undo the MusicXML is the original', (await musicXml(page)) === xml0);
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(100);
    }
    s = await savedWhen(page, id, (x) => sameNotes(x.arrangements[level].notes, full.arrangements[level].notes) && x.sheet?.tempos?.length);
    await page.waitForTimeout(1500);
    const xmlRedone = await musicXml(page);
    check('redo brings every marking back', xmlRedone === xmlFull);
    await page.reload();
    await page.waitForURL(/\/studio\/.+/);
    await sheetReady(page);
    await page.waitForTimeout(1200);
    const xmlReloaded = await musicXml(page);
    check('reload: the markings are kept (IndexedDB) and the MusicXML is identical', xmlReloaded === xmlRedone);
    await page.screenshot({ path: path.join(shots, 'm2-after-reload.png') });
    check('desktop: no CSP violations or console errors', (await page.evaluate(() => window.__csp.length)) === 0 && errors.length === 0, { errors: errors.slice(0, 5) });
    await ctx.close();
  }

  // ---------------------------------------------------------------- phone: dock tabs
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const id = songId(page);
    await page.getByRole('radio', { name: /Sheet music/ }).first().click();
    await sheetReady(page);
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /^Edit/ }).first().click();
    await page.waitForTimeout(600);
    const hs = await heads(page);
    const h = hs.find((x) => !x.ids.includes(',')) ?? hs[0];
    await page.touchscreen.tap(h.x, h.y);
    await page.waitForTimeout(300);
    await page.getByTestId('sheet-tab-marks').tap();
    await page.waitForTimeout(200);
    const n = await drawnCount(page);
    await page.getByTestId('sheet-finger-2').tap();
    await redrawn(page, n);
    const s = await savedWhen(page, id, (x) => x.arrangements.hard.notes.some((m) => m.finger === 2));
    const small = async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="sheet-edit-dock"] button')].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && (r.width < 44 || r.height < 44);
        }).length,
      );
    const smallMarks = await small();
    await page.screenshot({ path: path.join(shots, 'm2-phone-marks.png') });
    await page.getByTestId('sheet-tab-bar').tap();
    await page.getByTestId('sheet-tempo-open').tap();
    await page.waitForSelector('[data-testid="sheet-tempo-picker"]');
    const smallBar = await small();
    await page.screenshot({ path: path.join(shots, 'm2-phone-tempo.png') });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('phone: Marks tab sets a finger by tap; Bar tab opens the tempo picker; dock buttons ≥ 44 px; no sideways scroll', !!s?.arrangements.hard.notes.some((m) => m.finger === 2) && smallMarks === 0 && smallBar === 0 && !overflow && errors.length === 0, { smallMarks, smallBar, overflow, errors });
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
