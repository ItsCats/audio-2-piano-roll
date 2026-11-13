/**
 * Note editing on the sheet music, in Playwright Chromium on a production build served with the
 * exact netlify.toml headers (tests/e2e/isolation.server.py).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/sheetEdit.mjs --dist /tmp/p2v-dist [--port 5712] [--shots DIR]
 *
 * Desktop 1280×800 (the demo, J. S. Bach, public domain; and synthetic MIDI made here):
 *  - Sheet music → Edit keeps the sheet (no switch to the piano roll);
 *  - clicking a drawn notehead's centre selects exactly its notes, at zoom 50 %, 100 % and 150 %;
 *  - ↑ changes the pitch (store and MusicXML download); ] lengthens; Delete removes; a
 *    double-click adds a note at the pitch under the pointer; H moves a note to the bass staff;
 *  - the piano roll shows the same selection and the changed notes; the MIDI download has them;
 *  - Ctrl+Z undoes every step (back to the original notes, no grid lock); redo, reload: the edits
 *    are kept in IndexedDB and the MusicXML is identical;
 *  - an old song (no sheet data) and one with damaged sheet data still open;
 *  - a long synthetic Hard song (200 bars): the edit is on screen within 300 ms of the key press,
 *    and only one chunk is redrawn.
 * Screenshots: m1-*.png in --shots (deviceScaleFactor 2).
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
const port = Number(opt('port', '5712'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheetedit-')));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/sheetEdit.mjs --dist BUILD_DIR [--port N] [--shots DIR]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheetedit-work-'));
const { chromium } = await import('playwright');
const { Midi } = require('@tonejs/midi');

/** A made-up written-out piece: `bars` bars of 4/4 at 120 BPM, right-hand 8ths, left-hand quarters. */
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

async function newPage() {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
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

const drawnCount = (page) => page.evaluate(() => performance.getEntriesByName('sheet:all-chunks').length + performance.getEntriesByName('sheet:edit-done').length);
const sheetReady = (page) => page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
/** Waits until the sheet has been drawn again after an action. */
async function redrawn(page, before) {
  await page.waitForFunction((n) => performance.getEntriesByName('sheet:all-chunks').length + performance.getEntriesByName('sheet:edit-done').length > n, before, { timeout: 30000 });
  await page.waitForTimeout(120);
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
const idbPut = (page, song) =>
  page.evaluate(
    (song) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('pianovision');
        r.onsuccess = () => {
          const tx = r.result.transaction(['songs', 'summaries'], 'readwrite');
          tx.objectStore('songs').put(song);
          tx.objectStore('summaries').put({ id: song.id, title: song.title, createdAt: song.createdAt, updatedAt: song.updatedAt, duration: song.duration, source: song.source, noteCount: 1, bpm: song.tempo.bpm, estimated: false });
          tx.oncomplete = () => {
            r.result.close();
            res(true);
          };
          tx.onerror = () => rej(tx.error);
        };
      }),
    song,
  );
/** Polls IndexedDB until `pred(song)` holds (the save runs 600 ms after an edit). */
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
const heads = (page) =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-testid="sheet-scroll"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-note-ids]')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { ids: e.getAttribute('data-note-ids'), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })
      .filter((h) => h.ids && h.y > sc.top + 70 && h.y < sc.bottom - 30 && h.x > sc.left + 10 && h.x < sc.right - 10);
  });
const selectedIds = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('.sheet-sel')].flatMap((e) => (e.getAttribute('data-note-ids') || '').split(',').filter(Boolean)))].sort());
async function download(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), action()]);
  const file = path.join(work, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return file;
}
async function exportItem(page, label) {
  await page.getByRole('button', { name: /Export/ }).last().click();
  await page.getByRole('menuitem', { name: label }).click();
}
const musicXml = async (page) => fs.readFileSync(await download(page, () => exportItem(page, /MusicXML/)), 'utf8');
const noteOf = (song, level, id) => song.arrangements[level].notes.find((n) => n.id === id);
const sameNotes = (a, b) => JSON.stringify(a.map((n) => [n.id, n.midi, n.start, n.dur, n.hand])) === JSON.stringify(b.map((n) => [n.id, n.midi, n.start, n.dur, n.hand]));

try {
  // ---------------------------------------------------------------- desktop: the demo
  {
    const { page, errors } = await newPage();
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    const id = songId(page);
    await page.getByRole('radio', { name: /Sheet music/ }).click();
    await sheetReady(page);
    await page.waitForTimeout(600);
    const original = await idbSong(page, id);
    check('old song: the demo has no sheet data before an edit', !('sheet' in original));
    const xml0 = await musicXml(page);
    await page.keyboard.press('e');
    await page.waitForTimeout(500);
    check('Sheet → Edit stays on the sheet with the edit bar', (await page.locator('.sheet-chunk svg').count()) > 0 && (await page.locator('[data-testid="sheet-edit-bar"]').count()) === 1);
    await page.screenshot({ path: path.join(shots, 'm1-edit-bar.png') });

    // clicking a notehead centre selects exactly its notes, at 50 %, 100 % and 150 %
    for (const [zoomLabel, clicks] of [['100%', []], ['50%', Array(5).fill('Smaller')], ['150%', Array(10).fill('Bigger')]]) {
      for (const c of clicks) {
        const n = await drawnCount(page);
        await page.getByRole('button', { name: c, exact: true }).click();
        await redrawn(page, n);
      }
      await page.waitForTimeout(300);
      const hs = await heads(page);
      const picks = [0, Math.floor(hs.length / 3), Math.floor((2 * hs.length) / 3), hs.length - 1].map((i) => hs[i]).filter(Boolean);
      let ok = picks.length >= 3;
      const bad = [];
      for (const h of picks) {
        await page.mouse.click(h.x, h.y);
        await page.waitForTimeout(150);
        const sel = await selectedIds(page);
        const want = h.ids.split(',').sort();
        if (JSON.stringify(sel) !== JSON.stringify(want)) {
          ok = false;
          bad.push({ want, sel });
        }
      }
      check(`zoom ${zoomLabel}: a click on a notehead selects exactly its notes`, ok, { tried: picks.length, bad });
      if (zoomLabel === '150%') await page.screenshot({ path: path.join(shots, 'm1-zoom150-selected.png') });
    }
    await page.getByTitle('Reset size').click();
    await page.waitForTimeout(1500);

    // pick a single right-hand note in the second line and edit it
    const hs = await heads(page);
    const target = hs.find((h) => !h.ids.includes(',') && h.y > hs[0].y + 120) ?? hs[5];
    const tid = Number(target.ids);
    const level = 'hard';
    const before = noteOf(original, level, tid);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(150);
    const status0 = await page.locator('[data-testid="sheet-status"]').innerText();
    let n = await drawnCount(page);
    await page.keyboard.press('ArrowUp');
    await redrawn(page, n);
    let s = await savedWhen(page, id, (x) => noteOf(x, level, tid)?.midi !== before.midi);
    const up = noteOf(s, level, tid);
    check('↑ moves the note up a step in the key (store), same place', up.midi > before.midi && up.midi - before.midi <= 2 && up.start === before.start && !!s.sheet, { before: before.midi, after: up.midi, status0 });
    const xml1 = await musicXml(page);
    check('↑ changes the MusicXML download', xml1 !== xml0);
    await page.screenshot({ path: path.join(shots, 'm1-pitch-up.png') });

    n = await drawnCount(page);
    await page.keyboard.press(']');
    await redrawn(page, n);
    s = await savedWhen(page, id, (x) => noteOf(x, level, tid)?.dur > up.dur);
    check('] lengthens the note', noteOf(s, level, tid).dur > up.dur, { before: up.dur, after: noteOf(s, level, tid).dur });

    n = await drawnCount(page);
    await page.keyboard.press('h');
    await redrawn(page, n);
    s = await savedWhen(page, id, (x) => noteOf(x, level, tid)?.hand === 'L');
    const hLeft = (await heads(page)).find((h) => h.ids === String(tid));
    check('H moves the note to the left hand (bass staff)', noteOf(s, level, tid).hand === 'L' && !!hLeft && hLeft.y > target.y + 30, { y0: target.y, y1: hLeft?.y });
    await page.screenshot({ path: path.join(shots, 'm1-hand-swap.png') });

    // delete another note
    const other = (await heads(page)).find((h) => !h.ids.includes(',') && Number(h.ids) !== tid);
    const delId = Number(other.ids);
    await page.mouse.click(other.x, other.y);
    n = await drawnCount(page);
    await page.keyboard.press('Delete');
    await redrawn(page, n);
    s = await savedWhen(page, id, (x) => !noteOf(x, level, delId));
    check('Delete removes the note', !noteOf(s, level, delId));

    // double-click on the treble staff, on the line of a drawn note, where there is no note: adds that pitch
    const ref = (await heads(page)).find((h) => !h.ids.includes(',') && noteOf(s, level, Number(h.ids))?.hand === 'R');
    const refNote = noteOf(s, level, Number(ref.ids));
    const count0 = s.arrangements[level].notes.length;
    const spot = await page.evaluate(
      ({ y, x }) => {
        const all = [...document.querySelectorAll('[data-note-ids]')].map((e) => e.getBoundingClientRect());
        // the free x nearest the reference on its line (no notehead within 16 px horizontally on that line)
        for (let dx = 20; dx < 400; dx += 6)
          for (const sx of [x + dx, x - dx]) if (!all.some((r) => Math.abs(r.left + r.width / 2 - sx) < 16 && Math.abs(r.top + r.height / 2 - y) < 40)) return sx;
        return null;
      },
      { y: ref.y, x: ref.x },
    );
    n = await drawnCount(page);
    await page.mouse.dblclick(spot, ref.y);
    await redrawn(page, n);
    s = await savedWhen(page, id, (x) => x.arrangements[level].notes.length > count0);
    const added = s.arrangements[level].notes.filter((x) => !original.arrangements[level].notes.some((o) => o.id === x.id));
    check('double-click adds a note at the pitch under the pointer', added.length === 1 && Math.abs(added[0].midi - refNote.midi) <= 1 && added[0].hand === 'R' && !!added[0].pin, { ref: refNote.midi, added: added[0] && { midi: added[0].midi, start: added[0].start } });
    await page.screenshot({ path: path.join(shots, 'm1-added.png') });
    const edited = s;

    // the piano roll shows the same notes, the same selection
    const selBefore = await page.locator('[data-testid="sheet-status"]').innerText();
    await page.getByRole('radio', { name: /Piano roll/ }).click();
    await page.waitForTimeout(800);
    const rollStatus = await page.locator('text=/· left|· right|notes selected/').first().innerText().catch(() => '');
    check('piano roll: the selection carries over (the added note)', /right/.test(rollStatus), { sheet: selBefore, roll: rollStatus });
    await page.screenshot({ path: path.join(shots, 'm1-roll-after-edit.png') });
    const midiFile = await download(page, () => exportItem(page, /MIDI file/));
    const parsed = new Midi(fs.readFileSync(midiFile));
    const midiNotes = parsed.tracks.flatMap((t) => t.notes);
    check('the MIDI download has the edited notes (playback / video use the same notes)', midiNotes.length === s.arrangements[level].notes.length && midiNotes.some((m) => m.midi === up.midi && Math.abs(m.time - up.start) < 0.01), { midi: midiNotes.length, song: s.arrangements[level].notes.length });
    await page.getByRole('radio', { name: /Sheet music/ }).click();
    await sheetReady(page);
    await page.waitForTimeout(800);

    // undo everything (5 edits), then redo
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(120);
    }
    s = await savedWhen(page, id, (x) => !x.sheet && sameNotes(x.arrangements[level].notes, original.arrangements[level].notes));
    check('Ctrl+Z undoes every step (notes as before, no grid lock)', !s.sheet && sameNotes(s.arrangements[level].notes, original.arrangements[level].notes));
    await page.waitForTimeout(1200);
    const xmlUndone = await musicXml(page);
    check('after undo the MusicXML is the original', xmlUndone === xml0);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(120);
    }
    s = await savedWhen(page, id, (x) => !!x.sheet && sameNotes(x.arrangements[level].notes, edited.arrangements[level].notes));
    check('redo brings every edit back', sameNotes(s.arrangements[level].notes, edited.arrangements[level].notes));
    await page.waitForTimeout(1500);
    const xmlRedone = await musicXml(page);
    await page.reload();
    await page.waitForURL(/\/studio\/.+/);
    await sheetReady(page);
    await page.waitForTimeout(1000);
    const xmlReloaded = await musicXml(page);
    const s2 = await idbSong(page, id);
    const firstDiff = [...xmlReloaded].findIndex((ch, i) => ch !== xmlRedone[i]);
    check('reload keeps the edits (IndexedDB) and the MusicXML is identical', !!s2.sheet && sameNotes(s2.arrangements[level].notes, edited.arrangements[level].notes) && xmlReloaded === xmlRedone && xmlRedone !== xml0, {
      sheet: !!s2.sheet,
      same: xmlReloaded === xmlRedone,
      changed: xmlRedone !== xml0,
      diff: firstDiff < 0 ? null : [xmlRedone.slice(firstDiff - 80, firstDiff + 80), xmlReloaded.slice(firstDiff - 80, firstDiff + 80)],
    });
    await page.screenshot({ path: path.join(shots, 'm1-after-reload.png') });

    // old song data and damaged sheet data both open
    const old = { ...original, id: 'old-format-song', title: 'Old format song' };
    const damaged = { ...s2, id: 'damaged-sheet-song', title: 'Damaged sheet data', sheet: { v: 1, grid: { beats: [3, 2, 1] } } };
    await idbPut(page, old);
    await idbPut(page, damaged);
    for (const sid of [old.id, damaged.id]) {
      await page.goto(`${base}/studio/${sid}`);
      await sheetReady(page);
      await page.waitForTimeout(500);
      check(`${sid} opens and its sheet is drawn`, (await page.locator('.sheet-chunk svg').count()) > 0);
    }
    check('demo: no CSP violations or console errors', (await page.evaluate(() => window.__csp.length)) === 0 && errors.length === 0, { errors: errors.slice(0, 5) });
    await page.context().close();
  }

  // ---------------------------------------------------------------- desktop: 200 bars on Hard
  {
    const { page, errors } = await newPage();
    const file = path.join(work, 'synthetic-200-bars.mid');
    synthMidi(file, 200);
    await page.goto(base + '/import?tab=midi');
    await page.setInputFiles('input[type=file]', file);
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    await page.getByRole('radio', { name: /hard/i }).click();
    const view = page.getByRole('radio', { name: /Sheet music/ });
    if ((await view.getAttribute('aria-checked')) !== 'true') await view.click();
    await sheetReady(page);
    await page.waitForFunction(() => performance.getEntriesByName('sheet:all-chunks').length > 0, null, { timeout: 60000 });
    await page.keyboard.press('e');
    await page.waitForTimeout(800);
    const chunks = await page.locator('.sheet-chunk').count();
    const hs = await heads(page);
    await page.mouse.click(hs[3].x, hs[3].y);
    await page.waitForTimeout(200);
    const timings = [];
    for (const key of ['ArrowUp', 'ArrowDown', 'BracketRight']) {
      await page.evaluate(() => {
        window.__k = 0;
        window.addEventListener('keydown', () => (window.__k = performance.now()), { capture: true, once: true });
      });
      const n = await drawnCount(page);
      await page.keyboard.press(key);
      await redrawn(page, n);
      const r = await page.evaluate(() => {
        const done = performance.getEntriesByName('sheet:edit-done').at(-1)?.startTime ?? 0;
        return { ms: Math.round(done - window.__k), redrawn: document.querySelector('[data-redrawn]')?.getAttribute('data-redrawn') };
      });
      timings.push(r);
    }
    check('200 bars on Hard: each edit on screen within 300 ms, one chunk redrawn', timings.every((t) => t.ms > 0 && t.ms < 300 && t.redrawn === '1'), { chunks, timings });
    await page.screenshot({ path: path.join(shots, 'm1-long-hard.png') });
    check('long song: no console errors', errors.length === 0, errors.slice(0, 5));
    await page.context().close();
  }

  // ---------------------------------------------------------------- phone: the dock, tap to select
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(base + '/');
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    await page.getByRole('radio', { name: /Sheet music/ }).first().click();
    await sheetReady(page);
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /^Edit/ }).first().click();
    await page.waitForTimeout(600);
    const dock = page.locator('[data-testid="sheet-edit-dock"]');
    const hs = await heads(page);
    const h = hs[Math.min(4, hs.length - 1)];
    await page.touchscreen.tap(h.x, h.y);
    await page.waitForTimeout(300);
    const sel = await selectedIds(page);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="sheet-edit-dock"] button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.width < 44 || r.height < 44);
      }).length,
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('phone: the edit dock shows, a tap selects the note, buttons ≥ 44 px, no sideways scroll', (await dock.count()) === 1 && JSON.stringify(sel) === JSON.stringify(h.ids.split(',').sort()) && small === 0 && !overflow && errors.length === 0, { sel, want: h.ids, small, overflow, errors });
    await page.screenshot({ path: path.join(shots, 'm1-phone-dock.png') });
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
