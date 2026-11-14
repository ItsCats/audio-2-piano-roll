/**
 * Setting the real tempo of a song from sheet music, as a user does it, in Playwright Chromium on a
 * production build served with the exact netlify.toml headers (tests/e2e/isolation.server.py).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/sheet-tempo.mjs --dist /tmp/p2v-dist [--port 6230] [--shots DIR] [--only desktop|iphone] [--no-read]
 *
 * Every score is made here (made-up notes, no titles from real music): 8 bars of 4/4 with right-hand
 * quarters and left-hand halves, with no tempo, a metronome mark of 72, the word "Andante", 6/8 with
 * a dotted quarter of 60, and one with a written tempo change and a fermata.
 *
 * On a computer (1440×900) and an iPhone 14 (screenshots at device scale 2):
 * - each score is imported (MIDI / Sheet music tab) and the Studio's Notes tab says where its tempo
 *   came from ("no tempo mark: a guess", "the metronome mark", "Guessed from “Andante”", ♩. = 60);
 * - Notes → Tempo → Set tempo re-times the whole song: Hard (and Easy, Medium, the base notes) play
 *   at the new tempo (note spacing in the saved song, the playback clock passing the notes), the
 *   length follows, the sheet keeps its 8 bars and writes the new tempo, the MIDI file's tempo is the
 *   new one, a written tempo change and a fermata keep their proportions;
 * - Undo (the Tempo section's button, and Ctrl+Z in Edit mode on the computer) puts everything back
 *   in one step, Half sets half the number, and the tempo survives a reload;
 * - unless --no-read, PDFs read by the Accurate reader: one exported by the app (its text says
 *   "= 72": the import screen fills it in and the song plays at 72), a scanned copy (no text) with a
 *   tempo typed on the import screen, and on the phone the scanned copy read with nothing typed: the
 *   Studio says the reader doesn't read tempo marks, and its "Set the tempo" link leads to the field.
 * Also: the "tempo is a guess" strip and the speed menu's "Wrong tempo?" and a tap on the sheet's
 * tempo mark open the tempo field; a wrong number says why, a changed one says to tap Set tempo;
 * the sheet editor's bar-1 tempo changes the speed with no "plays a recording" message.
 * No console errors, no sideways page scroll on the phone, cross-origin isolated.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const args = process.argv.slice(2);
const opt = (name, def) => (args.indexOf(`--${name}`) < 0 ? def : args[args.indexOf(`--${name}`) + 1]);
const dist = opt('dist');
const port = Number(opt('port', '6230'));
const only = opt('only');
const read = !args.includes('--no-read');
const shots = opt('shots') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheet-tempo-'));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/sheet-tempo.mjs --dist BUILD_DIR [--port N] [--shots DIR] [--only desktop|iphone] [--no-read]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheet-tempo-work-'));
const { chromium, devices } = require('playwright');
const { Midi } = require('@tonejs/midi');

let failed = false;
const check = (name, ok, info) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
};

// ---------------------------------------------------------------- synthetic scores

const STEP = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALT = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const pitch = (m) => `<pitch><step>${STEP[m % 12]}</step>${ALT[m % 12] ? `<alter>${ALT[m % 12]}</alter>` : ''}<octave>${Math.floor(m / 12) - 1}</octave></pitch>`;
const METRO = (bpm, unit = 'quarter', dot = false) =>
  `<direction placement="above"><direction-type><metronome><beat-unit>${unit}</beat-unit>${dot ? '<beat-unit-dot/>' : ''}<per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff></direction>`;
const WORDS = (w) => `<direction placement="above"><direction-type><words font-weight="bold">${w}</words></direction-type><staff>1</staff></direction>`;
function scoreXml(title, { bars = 8, beats = 4, beatType = 4, head = '', at = {}, fermataBar = 0 } = {}) {
  const div = 2;
  const beatDur = (div * 4) / beatType;
  const bar = beats * beatDur;
  const rh = [72, 74, 76, 77, 79, 77, 76, 74];
  const ms = [];
  for (let b = 1; b <= bars; b++) {
    let s = '';
    if (b === 1)
      s += `<attributes><divisions>${div}</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>${head}`;
    if (at[b]) s += at[b];
    const type = beatType === 8 ? 'eighth' : 'quarter';
    for (let i = 0; i < beats; i++)
      s += `<note>${pitch(rh[(b + i) % 8])}<duration>${beatDur}</duration><voice>1</voice><type>${type}</type><staff>1</staff>${i === 0 && b === fermataBar ? '<notations><fermata/></notations>' : ''}</note>`;
    s += `<backup><duration>${bar}</duration></backup>`;
    const half = bar / 2;
    s += `<note>${pitch(48 + (b % 4) * 2)}<duration>${half}</duration><voice>5</voice><staff>2</staff></note><note>${pitch(55)}<duration>${half}</duration><voice>5</voice><staff>2</staff></note>`;
    if (b === bars) s += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    ms.push(`<measure number="${b}">${s}</measure>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${ms.join('')}</part></score-partwise>`;
}
const SCORES = {
  none: { file: 'tempo-study-none.musicxml', xml: scoreXml('Tempo Study None') },
  mark: { file: 'tempo-study-mark.musicxml', xml: scoreXml('Tempo Study Mark', { head: METRO(72) }) },
  words: { file: 'tempo-study-words.musicxml', xml: scoreXml('Tempo Study Words', { head: WORDS('Andante') }) },
  compound: { file: 'tempo-study-compound.musicxml', xml: scoreXml('Tempo Study Compound', { bars: 4, beats: 6, beatType: 8, head: METRO(60, 'quarter', true) }) },
  changes: { file: 'tempo-study-changes.musicxml', xml: scoreXml('Tempo Study Changes', { bars: 7, head: METRO(100), fermataBar: 4, at: { 5: WORDS('Adagio') } }) },
};
for (const s of Object.values(SCORES)) fs.writeFileSync((s.path = path.join(work, s.file)), s.xml);

// ---------------------------------------------------------------- server, browser

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch();
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  iphone: { ...devices['iPhone 14'], deviceScaleFactor: 2 },
};

async function newPage(dev) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...DEVICES[dev] });
  await ctx.addInitScript(() => {
    // the Accurate reader (the default on computers; phones default to the Quick one)
    try {
      const k = 'piano2vision-import-prefs';
      const p = JSON.parse(localStorage.getItem(k) || '{"separate":{}}');
      if (!p.sheetReader) localStorage.setItem(k, JSON.stringify({ ...p, sheetReader: 'accurate' }));
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => {
    errors.push('unexpected dialog: ' + d.message());
    void d.accept();
  });
  return { ctx, page, errors };
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
async function savedWhen(page, id, pred, ms = 10000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < ms) {
    s = await idbSong(page, id);
    if (s && pred(s)) return s;
    await page.waitForTimeout(150);
  }
  return s;
}
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
/** Right-hand note spacing → beats of the right hand per minute (one note per beat in every score). */
function rhPerMinute(notes) {
  const starts = [...new Set(notes.filter((n) => n.hand === 'R').map((n) => Math.round(n.start * 1e4) / 1e4))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);
  const g = median(gaps.filter((x) => x > 0.05));
  return g ? Math.round((60 / g) * 10) / 10 : null;
}
const rhStarts = (notes) => notes.filter((n) => n.hand === 'R').map((n) => n.start).sort((a, b) => a - b);
const levels = (s) => Object.fromEntries(['easy', 'medium', 'hard'].map((d) => [d, rhPerMinute(s.arrangements[d].notes)]));
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

async function importScore(page, file) {
  await page.goto(base + '/import?tab=midi');
  await page.getByText('Drop a MIDI or sheet-music file').waitFor();
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await page.waitForURL(/\/studio\/.+/, { timeout: 120000 });
  await page.waitForTimeout(1200);
  return songId(page);
}
async function openNotes(page) {
  const tab = page.getByRole('tab', { name: 'Notes' });
  if (!(await tab.filter({ visible: true }).count())) {
    await page.getByRole('button', { name: 'Show panel' }).filter({ visible: true }).first().click();
    await page.waitForTimeout(400);
  }
  await tab.filter({ visible: true }).first().click();
  await page.waitForTimeout(300);
  await page.getByTestId('song-tempo-input').scrollIntoViewIfNeeded();
}
async function closePanel(page) {
  const b = page.getByRole('button', { name: 'Close panel' }).filter({ visible: true });
  if (await b.count()) await b.first().click();
  const h = page.getByRole('button', { name: 'Hide panel' }).filter({ visible: true });
  if (await h.count()) await h.first().click();
  await page.waitForTimeout(300);
}
const tempoText = (page) => page.getByTestId('tempo-from').innerText();
/** Note heads on the sheet (Edit mode), screen coordinates. */
const heads = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="sheet-scroll"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-note-ids]')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { ids: e.getAttribute('data-note-ids'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })
      .filter((h) => h.ids && h.y > sc.top + 70 && h.y < sc.bottom - 24 && h.x > sc.left + 8 && h.x < sc.right - 8);
  });
async function setTempo(page, id, value, unit) {
  if (unit) await page.getByTestId('song-tempo-unit').selectOption(unit);
  await page.getByTestId('song-tempo-input').fill(String(value));
  const before = await idbSong(page, id);
  await page.getByTestId('song-tempo-set').click();
  return savedWhen(page, id, (s) => s.duration !== before.duration);
}
/** Plays about 3 s from the start; how many right-hand notes of the saved song the clock passed per minute. */
async function playRate(page, s) {
  await closePanel(page);
  const pos = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('[aria-label^="Song position"]')].find((e) => e.getBoundingClientRect().width > 0);
      return el ? Number(el.getAttribute('aria-valuenow')) : null;
    });
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  const p0 = await pos();
  await page.getByRole('button', { name: /^Play/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(3200);
  await page.getByRole('button', { name: /^Pause/ }).filter({ visible: true }).first().click();
  const p1 = await pos();
  const starts = rhStarts(s.arrangements.hard.notes).filter((t) => t >= (p0 ?? 0) - 1e-6 && t < (p1 ?? 0));
  return { p0, p1, passed: starts.length, perMinute: p1 > p0 ? Math.round((starts.length / (p1 - p0)) * 60) : null };
}
/** The Export menu button (on a phone it shows only its icon). */
const exportButton = (page) => page.locator('button[aria-haspopup="menu"]:has(svg.lucide-download)').filter({ visible: true }).last();
async function download(page, label) {
  await closePanel(page);
  await exportButton(page).click();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('menuitem', { name: label }).click()]);
  const file = path.join(work, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  await page.getByRole('button', { name: 'Got it' }).click({ timeout: 800 }).catch(() => {});
  return file;
}
const midiOf = (file) => new Midi(fs.readFileSync(file));
async function undoButton(page) {
  await openNotes(page);
  await page.getByTestId('song-tempo-undo').click();
}

/** The tempo the reader's song was saved with, and how it plays. */
async function readPdf(page, file, { typed } = {}) {
  await page.goto(base + '/import?tab=midi');
  await page.getByText('PDFs and photos of sheet music').waitFor();
  await page.locator('[role="button"] input[type="file"]').first().setInputFiles(file);
  await page.waitForSelector('[data-testid="pdf-pages"] button[aria-label^="Page "] img', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const prefilled = await page.getByTestId('import-tempo-input').inputValue();
  const unit = await page.getByTestId('import-tempo-unit').inputValue();
  const note = await page.getByTestId('import-tempo-note').innerText();
  if (typed) await page.getByTestId('import-tempo-input').fill(String(typed));
  const t0 = Date.now();
  await page.getByRole('button', { name: /^Read 1 page/ }).click();
  while (!/\/studio\//.test(page.url())) {
    const t = await page.evaluate(() => document.querySelector('.panel[aria-live="polite"]')?.textContent ?? '').catch(() => '');
    if (/Import failed/.test(t)) throw new Error(t.slice(0, 300));
    if (Date.now() - t0 > 12 * 60_000) throw new Error('read timed out');
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2000);
  return { prefilled, note, unit, id: songId(page), seconds: Math.round((Date.now() - t0) / 1000) };
}

// ---------------------------------------------------------------- runs

const pdfs = {};
try {
  for (const dev of Object.keys(DEVICES)) {
    if (only && only !== dev) continue;
    const phone = dev === 'iphone';
    const { ctx, page, errors } = await newPage(dev);

    // ---- no tempo in the file: 120, a guess; set 60
    let id = await importScore(page, SCORES.none.path);
    let s0 = await idbSong(page, id);
    check(`${dev} no tempo: plays at 120 (Hard), length 16 s`, rhPerMinute(s0.arrangements.hard.notes) === 120 && Math.abs(s0.duration - 16) < 0.01, { qpm: rhPerMinute(s0.arrangements.hard.notes), duration: s0.duration });
    // the strip under the header: the tempo is a guess; its "Set tempo" opens the field
    const guessNotice = await page.getByTestId('tempo-guess-notice').innerText().catch(() => '');
    check(`${dev} no tempo: a strip under the header says the tempo is a guess`, /No metronome mark/.test(guessNotice) && /♩ = 120 is a guess/.test(guessNotice), guessNotice);
    if (phone) await shot(page, `${dev}-none-notice`);
    await closePanel(page);
    await page.getByTestId('notice-set-tempo').click();
    await page.waitForTimeout(800);
    check(`${dev} no tempo: the strip's "Set tempo" opens Notes with the cursor in the tempo field`, await page.evaluate(() => document.activeElement?.id === 'song-tempo-input'));
    await openNotes(page);
    // a wrong number says why; a changed number says to tap Set tempo
    await page.getByTestId('song-tempo-input').fill('500');
    const helpBad = await page.getByTestId('song-tempo-help').innerText();
    check(`${dev} 500 typed: says the range, Set tempo off`, /between 20 and 400/.test(helpBad) && (await page.getByTestId('song-tempo-set').isDisabled()), helpBad);
    await page.getByTestId('song-tempo-input').fill('120');
    await page.getByTestId('song-tempo-double').click();
    const helpPending = await page.getByTestId('song-tempo-help').innerText();
    check(`${dev} Double: 240 in the box, "Tap Set tempo", the song still at 120`, (await page.getByTestId('song-tempo-input').inputValue()) === '240' && /Tap Set tempo/.test(helpPending) && (await page.getByTestId('song-tempo-set').getAttribute('data-pending')) === 'true' && Math.abs((await idbSong(page, id)).duration - 16) < 1e-6, helpPending);
    if (phone) await page.locator('section', { has: page.getByTestId('song-tempo-input') }).screenshot({ path: path.join(shots, `${dev}-none-tempo-pending.png`) });
    await page.getByTestId('song-tempo-input').fill('120');
    let txt = await tempoText(page);
    check(`${dev} no tempo: the Notes tab says ♩ = 120 is a guess`, /♩ = 120/.test(txt) && /guess/.test(txt) && /no tempo mark/.test(txt), txt);
    check(`${dev} no tempo: the field shows 120, labeled in quarter notes`, (await page.getByTestId('song-tempo-input').inputValue()) === '120' && /quarter note = 120/.test(await page.locator('label[for="song-tempo-input"]').innerText()));
    await page.locator('section', { has: page.getByTestId('song-tempo-input') }).screenshot({ path: path.join(shots, `${dev}-none-tempo-section.png`) });
    if (phone) check(`${dev}: no sideways scroll with the Notes tab open`, (await sideScroll(page)) <= 0, await sideScroll(page));
    let s1 = await setTempo(page, id, 60);
    check(`${dev} set ♩ = 60: Hard, Medium, Easy and the base notes play at 60`, Object.values(levels(s1)).every((q) => q === 60) && rhPerMinute(s1.base) === 60, { ...levels(s1), base: rhPerMinute(s1.base) });
    check(`${dev} set ♩ = 60: Hard note times doubled exactly`, rhStarts(s1.arrangements.hard.notes).every((t, i) => Math.abs(t - 2 * rhStarts(s0.arrangements.hard.notes)[i]) < 1e-9));
    check(`${dev} set ♩ = 60: length 32 s, tempo saved as set`, Math.abs(s1.duration - 32) < 1e-6 && s1.tempo.bpm === 60 && s1.tempo.qpm === 60 && s1.tempo.from === 'set', { duration: s1.duration, tempo: { bpm: s1.tempo.bpm, qpm: s1.tempo.qpm, from: s1.tempo.from } });
    await page.waitForTimeout(300);
    const toastText = await page.evaluate(() => document.body.innerText.match(/Tempo set: ♩ = 60[^\n]*/)?.[0] ?? '');
    check(`${dev} set ♩ = 60: confirmed with a message`, /Tempo set: ♩ = 60/.test(toastText), toastText);
    txt = await tempoText(page);
    check(`${dev} set ♩ = 60: the Notes tab says "Set by you"`, /♩ = 60/.test(txt) && /Set by you/.test(txt) && !/guess/.test(txt), txt);
    check(`${dev} set ♩ = 60: the "guess" strip is gone`, !(await page.getByTestId('tempo-guess-notice').count()));
    await shot(page, `${dev}-none-set-60`);
    // the speed menu: Escape closes it; "Wrong tempo?" opens the tempo setting
    await closePanel(page);
    const speedBtn = page.getByTitle('Playback speed').filter({ visible: true }).first();
    await speedBtn.click();
    const hasSet = await page.getByTestId('speed-set-tempo').isVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(`${dev} speed menu: a "Wrong tempo?" item, and Escape closes the menu`, hasSet && (await speedBtn.getAttribute('aria-expanded')) === 'false');
    await speedBtn.click();
    await page.getByTestId('speed-set-tempo').click();
    await page.waitForTimeout(800);
    check(`${dev} speed menu "Wrong tempo?": the cursor in the tempo field`, await page.evaluate(() => document.activeElement?.id === 'song-tempo-input'));
    const play = await playRate(page, s1);
    check(`${dev} set ♩ = 60: playback passes about one right-hand note a second`, play.perMinute >= 40 && play.perMinute <= 80, play);
    // the sheet: 8 bars, the new tempo written
    await page.getByRole('radio', { name: /Sheet music/ }).first().click();
    await page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
    await page.waitForTimeout(800);
    await shot(page, `${dev}-none-sheet-60`);
    // a tap on the sheet's tempo mark opens the tempo setting
    await closePanel(page);
    const mark = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="sheet-music"] svg text')].find((e) => /=\s*60/.test(e.textContent ?? '') && e.getBoundingClientRect().width > 0);
      const r = el?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (mark) await page.mouse.click(mark.x, mark.y);
    await page.waitForTimeout(800);
    check(`${dev} sheet: tapping "♩ = 60" opens the tempo setting`, !!mark && (await page.evaluate(() => document.activeElement?.id === 'song-tempo-input')), mark);
    const xml = fs.readFileSync(await download(page, /MusicXML/), 'utf8');
    const part1 = xml.slice(xml.indexOf('<part id="P1"'), xml.indexOf('</part>'));
    check(`${dev} set ♩ = 60: sheet keeps 8 bars of quarter notes and writes ♩ = 60`, (part1.match(/<measure /g) || []).length === 8 && /<per-minute>60<\/per-minute>/.test(xml) && /sound tempo="60"/.test(xml) && !/<type>eighth<\/type>/.test(part1), {
      measures: (part1.match(/<measure /g) || []).length,
    });
    const midi = midiOf(await download(page, /MIDI file/));
    const mStarts = midi.tracks.flatMap((t) => t.notes).map((n) => n.time).sort((a, b) => a - b);
    check(`${dev} set ♩ = 60: MIDI file tempo 60, notes a second apart`, Math.abs(midi.header.tempos[0].bpm - 60) < 0.01 && Math.abs(midi.duration - 32) < 0.05 && [...new Set(mStarts.map((t) => Math.round(t * 100) / 100))].slice(0, 4).join() === '0,1,2,3', { tempo: midi.header.tempos[0].bpm, duration: midi.duration });
    await page.getByRole('radio', { name: /Piano roll/ }).first().click();
    // undo in one step (the Tempo section's button), then Half from 120, then Ctrl+Z / redo in Edit mode
    await undoButton(page);
    let s2 = await savedWhen(page, id, (s) => Math.abs(s.duration - 16) < 1e-6);
    check(`${dev} Undo: one step back to ♩ = 120 everywhere`, Math.abs(s2.duration - 16) < 1e-9 && Object.values(levels(s2)).every((q) => q === 120) && s2.tempo.bpm === 120 && s2.tempo.from === 'default' && JSON.stringify(rhStarts(s2.arrangements.hard.notes)) === JSON.stringify(rhStarts(s0.arrangements.hard.notes)), { duration: s2.duration, ...levels(s2) });
    check(`${dev} Undo: the field shows 120 again`, (await page.getByTestId('song-tempo-input').inputValue()) === '120');
    await page.getByTestId('song-tempo-half').click();
    check(`${dev} Half: 60 in the field`, (await page.getByTestId('song-tempo-input').inputValue()) === '60');
    await page.getByTestId('song-tempo-set').click();
    s2 = await savedWhen(page, id, (s) => Math.abs(s.duration - 32) < 1e-6);
    check(`${dev} Half + Set tempo: ♩ = 60`, rhPerMinute(s2.arrangements.hard.notes) === 60);
    if (!phone) {
      await closePanel(page);
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+KeyZ');
      const u = await savedWhen(page, id, (s) => Math.abs(s.duration - 16) < 1e-6);
      await page.keyboard.press('Control+Shift+KeyZ');
      const r = await savedWhen(page, id, (s) => Math.abs(s.duration - 32) < 1e-6);
      check(`${dev} Ctrl+Z / Ctrl+Shift+Z in Edit mode undo and redo the tempo`, Math.abs(u.duration - 16) < 1e-6 && Math.abs(r.duration - 32) < 1e-6 && rhPerMinute(r.arrangements.hard.notes) === 60);
      await page.keyboard.press('KeyE');
    }
    await page.reload();
    await page.waitForTimeout(1500);
    await openNotes(page);
    txt = await tempoText(page);
    const s3 = await idbSong(page, id);
    check(`${dev} reload: still ♩ = 60, set by you`, /♩ = 60/.test(txt) && /Set by you/.test(txt) && rhPerMinute(s3.arrangements.hard.notes) === 60 && Math.abs(s3.duration - 32) < 1e-6, txt);

    // ---- a metronome mark: 72, from the mark
    id = await importScore(page, SCORES.mark.path);
    await openNotes(page);
    txt = await tempoText(page);
    s0 = await idbSong(page, id);
    check(`${dev} metronome mark: ♩ = 72 from the mark, no "guess"`, /♩ = 72/.test(txt) && /From the metronome mark/.test(txt) && !/guess/.test(txt) && rhPerMinute(s0.arrangements.hard.notes) === 72, txt);
    s1 = await setTempo(page, id, 144);
    s2 = await setTempo(page, id, 72);
    check(`${dev} 72 → 144 → 72: the same note times back (1e-6)`, rhPerMinute(s1.arrangements.hard.notes) === 144 && s2.arrangements.hard.notes.every((n, i) => Math.abs(n.start - s0.arrangements.hard.notes[i].start) < 1e-6 && Math.abs(n.dur - s0.arrangements.hard.notes[i].dur) < 1e-6) && Math.abs(s2.duration - s0.duration) < 1e-6);
    if (!pdfs.mark && read) {
      // the app's own PDF of this song: its text says "= 72"
      await closePanel(page);
      await page.getByRole('radio', { name: /Sheet music/ }).first().click();
      await page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
      await exportButton(page).click();
      await page.getByRole('menuitem', { name: /Sheet music PDF/ }).click();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Download PDF' }).click()]);
      await dl.saveAs((pdfs.mark = path.join(work, 'tempo-study-mark.pdf')));
      await page.getByRole('button', { name: 'Got it' }).click({ timeout: 800 }).catch(() => {});
      await page.getByRole('radio', { name: /Piano roll/ }).first().click();
    }

    if (!phone) {
      // the sheet editor's tempo on bar 1 changes the speed, with no "plays a recording" message
      await closePanel(page);
      await page.getByRole('radio', { name: /Sheet music/ }).first().click();
      await page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
      await page.waitForTimeout(600);
      await page.keyboard.press('e');
      await page.waitForTimeout(300);
      const hs = await heads(page);
      hs.sort((a, b) => a.y - b.y || a.x - b.x);
      const first = hs.filter((h) => Math.abs(h.y - hs[0].y) < 30).sort((a, b) => a.x - b.x)[0];
      await page.mouse.click(first.x, first.y);
      await page.waitForTimeout(250);
      await page.keyboard.press('Shift+T');
      await page.waitForSelector('[data-testid="sheet-tempo-picker"]');
      await page.getByTestId('sheet-tempo-bpm').fill('90');
      await page.getByTestId('sheet-tempo-apply').click();
      const s90 = await savedWhen(page, id, (x) => Math.abs(x.duration - (s0.duration * 72) / 90) < 1e-6);
      await page.waitForTimeout(300);
      const body = await page.evaluate(() => document.body.innerText);
      check(`${dev} sheet editor bar 1 = 90: plays at 90, no "plays a recording" message`, rhPerMinute(s90.arrangements.hard.notes) === 90 && !/plays a recording/.test(body), { qpm: rhPerMinute(s90.arrangements.hard.notes) });
      await page.keyboard.press('Escape');
      await page.keyboard.press('e');
      await page.getByRole('radio', { name: /Piano roll/ }).first().click();
      await page.waitForTimeout(300);
    }

    // ---- tempo words: a guess from "Andante"
    id = await importScore(page, SCORES.words.path);
    await openNotes(page);
    txt = await tempoText(page);
    check(`${dev} "Andante": ♩ = 76, guessed from the word`, /♩ = 76/.test(txt) && /Guessed from the word “Andante”/.test(txt) && /guess/.test(txt), txt);
    s1 = await setTempo(page, id, 66);
    check(`${dev} "Andante" set to 66: Hard plays at 66`, rhPerMinute(s1.arrangements.hard.notes) === 66);

    // ---- 6/8: dotted quarters
    id = await importScore(page, SCORES.compound.path);
    await openNotes(page);
    txt = await tempoText(page);
    check(`${dev} 6/8: shown as ♩. = 60, the field in dotted quarters`, /♩\. = 60/.test(txt) && (await page.getByTestId('song-tempo-unit').inputValue()) === 'q.' && /dotted quarter note = 60/.test(await page.locator('label[for="song-tempo-input"]').innerText()), txt);
    s1 = await setTempo(page, id, 40);
    check(`${dev} 6/8 set ♩. = 40: eighths 0.5 s apart`, rhPerMinute(s1.arrangements.hard.notes) === 120 && s1.tempo.qpm === 60, { rh: rhPerMinute(s1.arrangements.hard.notes), qpm: s1.tempo.qpm });
    const midi68 = midiOf(await download(page, /MIDI file/));
    check(`${dev} 6/8 MIDI file: quarter tempo 60, 6/8`, Math.abs(midi68.header.tempos[0].bpm - 60) < 0.01 && midi68.header.timeSignatures[0].timeSignature.join('/') === '6/8', { tempo: midi68.header.tempos[0].bpm });

    // ---- a written tempo change and a fermata keep their proportions
    id = await importScore(page, SCORES.changes.path);
    s0 = await idbSong(page, id);
    await openNotes(page);
    s1 = await setTempo(page, id, 80);
    const barStarts = (s) => rhStarts(s.arrangements.hard.notes).filter((_, i) => i % 4 === 0);
    const b0 = barStarts(s0);
    const b1 = barStarts(s1);
    check(`${dev} tempo change + fermata: every bar 1.25× longer (♩ = 100 → 80)`, b1.every((t, i) => Math.abs(t - b0[i] * 1.25) < 1e-6) && b0.length === 7, { before: b0.map((x) => +x.toFixed(3)), after: b1.map((x) => +x.toFixed(3)) });
    check(`${dev} tempo change + fermata: the fermata bar and the Adagio still longer`, b1[4] - b1[3] > (b1[1] - b1[0]) * 1.1 && b1[6] - b1[5] > (b1[1] - b1[0]) * 1.4);

    // ---- PDFs read by the Accurate reader
    if (read) {
      if (!pdfs.scan && pdfs.mark) pdfs.scan = await scannedCopy(pdfs.mark);
      if (!phone && pdfs.mark) {
        const r = await readPdf(page, pdfs.mark);
        const s = await idbSong(page, r.id);
        check(`${dev} PDF with "= 72" in its text: the import screen fills in 72`, r.prefilled === '72' && /Found on the page/.test(r.note), r);
        check(`${dev} PDF found tempo: the Beat shows what will be used (the time signature's beat when the note wasn't readable)`, (r.unit === 'meter') === /wasn’t readable/.test(r.note) && r.unit !== 'q', r);
        check(`${dev} PDF read: plays at 72 (Hard), 26.7 s, "Read from the text on the page"`, rhPerMinute(s.arrangements.hard.notes) === 72 && Math.abs(s.duration - 80 / 3) < 0.05 && s.tempo.from === 'page', { qpm: rhPerMinute(s.arrangements.hard.notes), duration: s.duration, from: s.tempo.from, notes: s.arrangements.hard.notes.length });
        await openNotes(page);
        check(`${dev} PDF read: the Notes tab says where the tempo came from`, /Read from the text on the page/.test(await tempoText(page)));
        await shot(page, `${dev}-pdf-found-studio`);
      }
      if (!phone && pdfs.scan) {
        const r = await readPdf(page, pdfs.scan, { typed: 60 });
        const s = await idbSong(page, r.id);
        check(`${dev} scanned PDF: nothing found, the import screen asks for it`, r.prefilled === '' && /reads the notes, not the tempo/.test(r.note), r);
        check(`${dev} scanned PDF with ♩ = 60 typed at import: plays at 60`, rhPerMinute(s.arrangements.hard.notes) === 60 && s.tempo.from === 'set' && s.tempo.qpm === 60, { qpm: rhPerMinute(s.arrangements.hard.notes), from: s.tempo.from });
      }
      if (phone && pdfs.scan) {
        const r = await readPdf(page, pdfs.scan);
        let s = await idbSong(page, r.id);
        check(`${dev} scanned PDF, nothing typed: plays at the default 120`, rhPerMinute(s.arrangements.hard.notes) === 120 && s.tempo.from === 'default', { qpm: rhPerMinute(s.arrangements.hard.notes), seconds: r.seconds });
        const strip = await page.getByTestId('sheet-reader-notice').innerText().catch(() => '');
        check(`${dev} reader song: the strip under the header says the tempo is a guess`, /♩ = 120 is a guess/.test(strip) && (await page.getByTestId('notice-set-tempo').count()) > 0, strip);
        await openNotes(page);
        await page.getByTestId('reader-tempo-note').scrollIntoViewIfNeeded();
        const note = await page.getByTestId('reader-tempo-note').innerText();
        check(`${dev} reader song: the notice says the reader doesn't read tempo marks`, /doesn’t read tempo marks, so this plays at ♩ = 120/.test(note), note);
        await shot(page, `${dev}-pdf-reader-note`);
        await page.getByRole('button', { name: 'Set the tempo printed on your page' }).click();
        await page.waitForTimeout(700);
        check(`${dev} reader song: the link puts the cursor in the tempo field`, await page.evaluate(() => document.activeElement?.id === 'song-tempo-input'));
        await shot(page, `${dev}-pdf-reader-tempo-field`);
        s = await setTempo(page, r.id, 60);
        check(`${dev} reader song set ♩ = 60: Hard plays at 60, twice as long`, rhPerMinute(s.arrangements.hard.notes) === 60 && Math.abs(s.duration - 32) < 0.05, { qpm: rhPerMinute(s.arrangements.hard.notes), duration: s.duration });
        check(`${dev} reader song: the notice is gone once the tempo is set`, !(await page.getByTestId('reader-tempo-note').count()));
        await shot(page, `${dev}-pdf-reader-set-60`);
        check(`${dev}: no sideways scroll (reader song, Notes tab)`, (await sideScroll(page)) <= 0, await sideScroll(page));
      }
    }
    if (phone) {
      await page.goto(base + '/import?tab=midi');
      await page.waitForTimeout(800);
      check(`${dev}: no sideways scroll on the import screen`, (await sideScroll(page)) <= 0);
    }
    check(`${dev}: cross-origin isolated`, await page.evaluate(() => crossOriginIsolated));
    check(`${dev}: no console errors`, errors.length === 0, errors.slice(0, 5));
    await ctx.close();
  }
} catch (e) {
  failed = true;
  console.error('RUN FAILED', e);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`screenshots: ${shots}`);
  console.log(failed ? 'FAILED' : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
}

/** A copy of a PDF as a scanned page: its first page as a JPEG picture, no text (pdf.js and @napi-rs/canvas in Node). */
async function scannedCopy(file) {
  const pdfjs = await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const { createCanvas } = require('@napi-rs/canvas');
  const fonts = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, standardFontDataUrl: fonts }).promise;
  const page = await doc.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: 2000 / v1.width });
  const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: c, viewport: vp, canvas }).promise;
  const jpg = canvas.toBuffer('image/jpeg', 92);
  const W = Math.round(v1.width);
  const H = Math.round(v1.height);
  const content = Buffer.from(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`);
  const objs = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),
    Buffer.from('<</Type/Pages/Kids[3 0 R]/Count 1>>'),
    Buffer.from(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>`),
    Buffer.concat([Buffer.from(`<</Type/XObject/Subtype/Image/Width ${canvas.width}/Height ${canvas.height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>\nstream\n`), jpg, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<</Length ${content.length}>>\nstream\n`), content, Buffer.from('endstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    offsets.push(at);
    parts.push(b);
    at += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  const out = path.join(work, 'tempo-study-scanned.pdf');
  fs.writeFileSync(out, Buffer.concat(parts));
  return out;
}
