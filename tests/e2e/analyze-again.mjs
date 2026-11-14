/**
 * "Analyze again" in the Studio (the song's stored recording analyzed once more with other settings,
 * the song itself kept) and "Reset {Level} to detected notes" (a toast, and Undo), in Playwright
 * Chromium on a PRODUCTION build served with the exact netlify.toml headers
 * (tests/e2e/isolation.server.py).
 *
 *   npm run build
 *   TMPDIR=/dev/shm node tests/e2e/analyze-again.mjs --dist dist [--port 6301] [--shots DIR] [--no-separation] [--no-phone]
 *
 * Nothing copyrighted: a synthetic MIDI file (4 bars of broken chords, every key held 0.12 s) is
 * imported, its Hard level is exported as WAV by the app's own piano engine, and that WAV is imported
 * with "Piano solo" and the normal model (the high-accuracy box forgotten).
 *
 * Desktop 1280×800:
 *  - the song is renamed, made a favorite, given a title-page subtitle, and one Hard fix is made;
 *  - Reset Hard asks first, then a toast says what was reset; its Undo brings the fix back; Reset on an
 *    unedited level says it is already as detected and offers Analyze again, which opens the dialog
 *    with Piano solo preselected and a loss text that names Hard;
 *  - Analyze again with the high-accuracy box ticked, cancelled within seconds: the song is exactly as
 *    it was, no crash marker is left; a reload mid-run leaves the song as it was too (no crash notice,
 *    no interrupted-import notice: nothing was written);
 *  - a tab that died during it (a crash marker without its lock): the re-analysis notice, the box off,
 *    and "Open the song" opens the dialog with the box unticked;
 *  - Analyze again with the high-accuracy piano model: same id, title, favorite and title-page text;
 *    method piano-specialist, notes as played (short, pedal heard), every level rebuilt (none edited),
 *    sheet data gone, the old version kept (role 'older'), one library entry with the new count;
 *  - Go back to the old notes: Basic Pitch with the Hard fix, Re-detect shown; Use the new analysis
 *    swaps back;
 *  - Analyze again with "Remove singing and drums" too (skipped with --no-separation): only the
 *    piano part was transcribed;
 *  - the MIDI song: "came straight from the MIDI file" with Import a recording.
 * iPhone 14 (deviceScaleFactor 2): the same import, the options with Import's phone warning, a run
 *   with the piano model, the result, the version card, the reset toast and the MIDI explanation, all
 *   without sideways scroll. Both: no console errors. Screenshots in --shots.
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
const port = Number(opt('port', '6301'));
const withSeparation = !args.includes('--no-separation');
const withPhone = !args.includes('--no-phone');
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-analyze-again-')));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/analyze-again.mjs --dist BUILD_DIR [--port N] [--shots DIR] [--no-separation] [--no-phone]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-analyze-again-work-'));
const { chromium, devices } = await import('playwright');
const { Midi } = require('@tonejs/midi');

let failed = false;
const check = (name, ok, info) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''}`);
};

// ---- the synthetic piece: 4 bars of 2 s, C Am F G, keys held briefly, pedal per bar
const midiFile = path.join(work, 'broken-chords.mid');
{
  const CHORDS = [
    [48, 60, 64, 67, 72],
    [45, 57, 60, 64, 69],
    [41, 53, 57, 60, 65],
    [43, 55, 59, 62, 67],
  ];
  const midi = new Midi();
  midi.header.setTempo(120);
  midi.header.update();
  const tr = midi.addTrack();
  CHORDS.forEach((c, b) => {
    const t0 = 0.5 + b * 2;
    c.forEach((m, i) => tr.addNote({ midi: m, time: t0 + i * 0.15, duration: 0.12, velocity: 0.6 }));
    tr.addCC({ number: 64, value: 1, time: t0 + 0.05 });
    tr.addCC({ number: 64, value: 0, time: t0 + 1.95 });
  });
  fs.writeFileSync(midiFile, Buffer.from(midi.toArray()));
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
};

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    await fetch(base + '/');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const browser = await chromium.launch();

async function newPage(contextOpts) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...contextOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // confirm() (Reset, Delete) and the leave-page question while a run is busy: yes
  page.on('dialog', (d) => void d.accept().catch(() => {}));
  return { ctx, page, errors };
}
const songIdOf = (page) => decodeURIComponent(new URL(page.url()).pathname.split('/').pop());
/** a record of the 'songs' store (or 'summaries'), and every key of a store */
const idb = (page, store, key) =>
  page.evaluate(
    ([store, key]) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('pianovision');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const os = r.result.transaction(store).objectStore(store);
          const g = key === null ? os.getAllKeys() : os.get(key);
          g.onsuccess = () => {
            res(g.result);
            r.result.close();
          };
          g.onerror = () => rej(g.error);
        };
      }),
    [store, key],
  );
async function storedSong(page, id, pred = () => true, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const s = await idb(page, 'songs', id);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) return s;
    await page.waitForTimeout(200);
  }
}
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const exportMenu = (page) => page.locator('button[aria-haspopup="menu"]:has(svg.lucide-download)').first();
const difficulty = (page, d) => page.getByRole('radiogroup', { name: 'Difficulty' }).getByRole('radio', { name: d }).click();
async function openPanel(page, tab) {
  if (!(await page.getByRole('tab', { name: tab }).count()) || !(await page.getByRole('tab', { name: tab }).isVisible())) await page.getByRole('button', { name: 'Show panel' }).first().click();
  await page.getByRole('tab', { name: tab }).click();
}
const dialog = (page) => page.getByRole('dialog', { name: 'Analyze again' });
const toastBox = (page, title) => page.getByText(title, { exact: true }).last();
async function dismissToasts(page) {
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 1000 }).catch(() => {});
}
/** the dialog from the Notes tab */
async function openAnalyze(page) {
  await openPanel(page, 'Notes');
  const btn = page.getByRole('button', { name: 'Analyze again…' });
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await dialog(page).waitFor();
}
async function setBox(page, name, on) {
  const box = dialog(page).getByRole('checkbox', { name });
  if ((await box.isChecked()) !== on) await box.setChecked(on);
}
const runButton = (page) => dialog(page).getByRole('button', { name: 'Analyze again', exact: true });
const strip = (s) => {
  // the fields a save at song open may change (lastPlayedAt is only set by open())
  const { lastPlayedAt: _l, ...rest } = s;
  void _l;
  return JSON.stringify(rest);
};
const markers = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => /running|separating/.test(k)));

async function importWav(page, wav) {
  await page.goto(`${base}/import`);
  await page.getByRole('heading', { name: 'Import music', exact: true }).waitFor();
  await page.getByRole('radiogroup', { name: 'Detection preset' }).getByRole('radio', { name: 'Piano solo' }).click();
  const box = page.getByRole('checkbox', { name: /High-accuracy piano model/ });
  if (await box.isChecked()) await box.uncheck();
  await page.locator('[role="button"] input[type="file"]').first().setInputFiles(wav);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 5 * 60000 });
  await page.locator('canvas').first().waitFor();
  return songIdOf(page);
}
async function importMidi(page) {
  await page.goto(`${base}/import?tab=audio`);
  await page.locator('input[type=file]:not([data-testid])').first().setInputFiles(midiFile);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 120000 });
  await page.locator('canvas').first().waitFor();
  return songIdOf(page);
}
/** runs Analyze again (dialog open) and waits for the result screen */
async function runAndWait(page, timeoutMs = 8 * 60000) {
  const t0 = Date.now();
  await runButton(page).click();
  await dialog(page).getByText('New notes are ready', { exact: true }).waitFor({ timeout: timeoutMs });
  return (Date.now() - t0) / 1000;
}

try {
  // ======== desktop
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 800 } });
  // 1. the recording: the synthetic MIDI's Hard level rendered by the app's piano engine
  const midiId = await importMidi(page);
  await difficulty(page, 'Hard');
  await exportMenu(page).click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.getByRole('menuitem', { name: /^Audio WAV \(hard\)/ }).click()]);
  const wav = path.join(work, 'practice-piece.wav');
  await d.saveAs(wav);
  await dismissToasts(page);

  // 2. imported with Piano solo and the normal model (the high-accuracy box forgotten)
  const id = await importWav(page, wav);
  let s0 = await storedSong(page, id);
  check('desktop: imported with the normal model', s0.transcription.method === 'basic-pitch' && s0.hasAudio === true, { method: s0.transcription.method });
  // renamed, a favorite, a title-page subtitle
  const titleInput = page.getByRole('textbox', { name: 'Song title' });
  await titleInput.fill('My practice piece');
  await titleInput.press('Tab');
  await page.locator('button:has(svg.lucide-film)').first().click();
  const exp = page.getByRole('dialog', { name: 'Export video' });
  await exp.waitFor();
  const titleSwitch = exp.getByRole('switch', { name: 'Add a title page' });
  if ((await titleSwitch.getAttribute('aria-checked')) !== 'true') await titleSwitch.click();
  await exp.getByLabel('Subtitle', { exact: true }).fill('For the recital');
  await page.waitForTimeout(700);
  await exp.getByRole('button', { name: 'Close' }).click();
  await page.goto(`${base}/library`);
  await page.getByRole('textbox', { name: 'Search songs' }).fill('My practice piece');
  await page.getByRole('button', { name: 'Favorite', exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.goto(`${base}/studio/${encodeURIComponent(id)}`);
  await page.locator('canvas').first().waitFor();
  // one fix on Hard: every note a semitone up (Edit mode, select all, ↑)
  await difficulty(page, 'Hard');
  await page.locator('canvas').first().click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('e');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('e');
  s0 = await storedSong(page, id, (s) => s.arrangements.hard.edited && s.title === 'My practice piece' && s.favorite === true);
  check('desktop: renamed, a favorite, Hard fixed', s0.title === 'My practice piece' && s0.favorite === true && s0.arrangements.hard.edited === true);
  const titleCard = () => page.evaluate((id) => (localStorage.getItem('piano2vision-title-card') ?? '').includes(id) && (localStorage.getItem('piano2vision-title-card') ?? '').includes('For the recital'), id);
  check('desktop: the title page text is stored for the song', await titleCard());

  // 3. Reset Hard: asks, then a toast; Undo brings the fix back
  await openPanel(page, 'Notes');
  await page.getByRole('button', { name: 'Reset Hard to detected notes' }).click();
  const resetToast = page.getByRole('alertdialog', { name: 'Hard reset to the detected notes' });
  await resetToast.waitFor({ timeout: 5000 });
  const resetBody = await resetToast.innerText();
  check('desktop: Reset Hard says what went back', /notes? went back to the detected version/.test(resetBody), resetBody.split('\n')[1]);
  let s1 = await storedSong(page, id, (s) => !s.arrangements.hard.edited);
  check('desktop: Hard is as detected after the reset', s1.arrangements.hard.edited === false);
  await page.screenshot({ path: path.join(shots, 'desktop-reset-toast.png') });
  await resetToast.getByRole('button', { name: 'Undo' }).click();
  await toastBox(page, 'Reset undone').waitFor({ timeout: 3000 });
  s1 = await storedSong(page, id, (s) => s.arrangements.hard.edited);
  check('desktop: Undo brings the fix back', s1.arrangements.hard.edited === true && JSON.stringify(s1.arrangements.hard.notes) === JSON.stringify(s0.arrangements.hard.notes));
  // an unedited level: already as detected, with Analyze again
  await difficulty(page, 'Medium');
  await page.getByRole('button', { name: 'Reset Medium to detected notes' }).click();
  const same = page.getByRole('alertdialog', { name: 'Medium is already as detected' });
  await same.waitFor({ timeout: 5000 });
  check('desktop: an unedited level is already as detected, Analyze again offered', /use Analyze again/.test(await same.innerText()));
  await same.getByRole('button', { name: 'Analyze again' }).click();
  await dialog(page).waitFor();
  const presetChecked = await dialog(page).getByRole('radiogroup', { name: 'Detection preset' }).getByRole('radio', { name: 'Piano solo' }).getAttribute('aria-checked');
  check('desktop: the dialog opens with Piano solo preselected', presetChecked === 'true');
  const loss = await dialog(page).getByTestId('analyze-loss').innerText();
  check('desktop: the loss text names the Hard fixes', /Your fixes on Hard/.test(loss) && /You can go back to the old notes afterward\./.test(loss), loss);
  check('desktop: "Last time" says how it was analyzed', (await dialog(page).getByTestId('analyze-last').innerText()) === 'Last time: Piano solo · standard model');
  await page.screenshot({ path: path.join(shots, 'desktop-options.png') });
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await difficulty(page, 'Hard');
  await dismissToasts(page);
  const before = await storedSong(page, id);

  // 4. cancel mid-run: nothing changes
  await openAnalyze(page);
  await setBox(page, /High-accuracy piano model/, true);
  await runButton(page).click();
  await dialog(page).getByText(/^Analyzing “My practice piece” again/).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'desktop-progress.png') });
  const tc = Date.now();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await dialog(page).waitFor({ state: 'detached', timeout: 5000 });
  await toastBox(page, 'Analyze again stopped').waitFor({ timeout: 3000 });
  check('desktop: Cancel stops it within 5 s', Date.now() - tc < 5000, `${Date.now() - tc} ms`);
  await page.waitForTimeout(1000);
  let after = await storedSong(page, id);
  check('desktop: after Cancel the song is exactly as it was', strip(after) === strip(before));
  check('desktop: no crash marker left', (await markers(page)).length === 0, await markers(page));
  check('desktop: no other version after Cancel', !(await idb(page, 'songs', `${id}:previous`)));

  // 5. a reload mid-run (the page asks first: yes): the song is untouched, nothing is offered to resume
  await openAnalyze(page);
  await runButton(page).click();
  await dialog(page).getByText(/^Analyzing “My practice piece” again/).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.reload();
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(1500);
  after = await storedSong(page, id);
  check('desktop: after a reload mid-run the song is exactly as it was', strip(after) === strip(before));
  check('desktop: after a reload no notice (nothing to resume, nothing crashed)', !(await page.getByRole('alertdialog').count()), await page.getByRole('alertdialog').allInnerTexts());
  const pend = await idb(page, 'pending', null);
  check('desktop: no interrupted-import record was written', Array.isArray(pend) && pend.length === 0, pend);

  // 6. a tab that died while the piano model ran (its marker without a lock): the notice, the box off
  await page.evaluate((id) => localStorage.setItem('piano2vision-piano-specialist-running', JSON.stringify({ reanalyze: id, title: 'My practice piece', at: Date.now() - 30000 })), id);
  await page.reload();
  const crash = page.getByRole('alertdialog', { name: 'The high-accuracy piano model stopped the page' });
  await crash.waitFor({ timeout: 8000 });
  const crashText = await crash.innerText();
  check('desktop: the crash notice is about Analyze again', /while analyzing “My practice piece” again\. Your song wasn’t changed/.test(crashText), crashText.split('\n')[1]);
  const prefsOff = await page.evaluate(() => JSON.parse(localStorage.getItem('piano2vision-import-prefs') ?? '{}').pianoModel !== true);
  check('desktop: the high-accuracy box is off after the crash', prefsOff);
  await page.screenshot({ path: path.join(shots, 'desktop-crash-notice.png') });
  await crash.getByRole('button', { name: 'Open the song' }).click();
  await dialog(page).waitFor({ timeout: 8000 });
  check('desktop: "Open the song" opens Analyze again with the box unticked', !(await dialog(page).getByRole('checkbox', { name: /High-accuracy piano model/ }).isChecked()));
  check('desktop: the ?analyze=1 parameter is gone', !new URL(page.url()).search, page.url());
  check('desktop: no interrupted-import notice', !(await page.getByRole('alertdialog', { name: /interrupted|didn’t finish/i }).count()));

  // 7. Analyze again with the high-accuracy piano model
  await setBox(page, /High-accuracy piano model/, true);
  const took = await runAndWait(page);
  console.log(`     high-accuracy re-analysis took ${took.toFixed(0)} s`);
  const doneText = await dialog(page).getByTestId('analyze-done').innerText();
  check('desktop: the result says what changed', /Piano solo · high-accuracy piano model · Hard: \d+ notes \(was \d+\)/.test(doneText), doneText.replace(/\n/g, ' | '));
  await page.screenshot({ path: path.join(shots, 'desktop-done.png') });
  const s2 = await storedSong(page, id);
  check('desktop: same song (id, title, favorite, created)', s2.id === id && s2.title === 'My practice piece' && s2.favorite === true && s2.createdAt === before.createdAt);
  check('desktop: the title page text is kept', await titleCard());
  check('desktop: analyzed by the high-accuracy piano model', s2.transcription.method === 'piano-specialist', s2.transcription.method);
  const hardDur = median(s2.arrangements.hard.notes.map((n) => n.dur));
  check('desktop: notes as played (short), the pedal heard', s2.noteLength === 'played' && s2.autoPedal === false && s2.basePedal.length >= 2 && hardDur <= 0.3, { noteLength: s2.noteLength, pedal: s2.basePedal.length, median: +hardDur.toFixed(3) });
  check('desktop: Hard, Medium and Easy rebuilt (none edited)', ['easy', 'medium', 'hard'].every((d) => s2.arrangements[d].edited === false && s2.arrangements[d].notes.length > 0 && s2.arrangements[d].generatedAt > before.arrangements[d].generatedAt));
  check('desktop: no sheet data, no posteriors flag', !('sheet' in s2) && s2.hasPosteriors === false && s2.hasAudio === true);
  const prev = await idb(page, 'songs', `${id}:previous`);
  check('desktop: the old notes are kept as the other version', prev?.otherVersion?.role === 'older' && prev.transcription.method === 'basic-pitch' && prev.arrangements.hard.edited === true);
  const keys = (await idb(page, 'summaries', null)) ?? [];
  const sum = await idb(page, 'summaries', id);
  check('desktop: one library entry per song (the other version is not listed), with the new count', keys.length === 2 && !keys.some((k) => String(k).includes(':')) && sum.noteCount === s2.base.length, { keys: keys.length, noteCount: sum.noteCount });
  await dialog(page).getByRole('button', { name: 'See the new notes' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  check('desktop: the Studio shows the new notes (Note length: As played)', (await page.getByRole('radiogroup', { name: 'Note length' }).getByRole('radio', { name: 'As played' }).getAttribute('aria-checked')) === 'true');
  check('desktop: the Notes tab says how it was analyzed', (await page.getByTestId('analyzed-as').innerText()) === 'Analyzed as: Piano solo · high-accuracy piano model');

  // 8. back to the old notes, and to the new ones again
  const card = page.getByTestId('version-card');
  await card.scrollIntoViewIfNeeded();
  check('desktop: the version card names the old notes', /^Your old notes are kept \(Piano solo · standard model, Hard: \d+ notes\)\./.test(await card.innerText()), (await card.innerText()).split('\n')[0]);
  await page.screenshot({ path: path.join(shots, 'desktop-version-card.png') });
  await card.getByRole('button', { name: 'Go back to the old notes' }).click();
  await toastBox(page, 'Back to the old notes').waitFor({ timeout: 5000 });
  const s3 = await storedSong(page, id, (s) => s.transcription.method === 'basic-pitch');
  check('desktop: back to the old notes (Basic Pitch, the Hard fix, posteriors)', s3.transcription.method === 'basic-pitch' && s3.arrangements.hard.edited === true && s3.hasPosteriors === true && s3.title === 'My practice piece');
  check('desktop: Re-detect is offered again', await page.getByRole('button', { name: 'Re-detect notes' }).isVisible());
  check('desktop: the card now offers the new analysis', /^You’re using the old notes\. The new analysis is kept/.test(await card.innerText()));
  await card.getByRole('button', { name: 'Use the new analysis' }).click();
  const s4 = await storedSong(page, id, (s) => s.transcription.method === 'piano-specialist');
  check('desktop: Use the new analysis swaps back', s4.transcription.method === 'piano-specialist' && s4.noteLength === 'played');
  await dismissToasts(page);

  // 9. "Remove singing and drums" with the piano model (a short clip: the separation runs in the browser)
  if (withSeparation) {
    await openAnalyze(page);
    await setBox(page, /High-accuracy piano model/, true);
    await setBox(page, /Remove singing and drums/, true);
    const t = await runAndWait(page, 12 * 60000);
    console.log(`     re-analysis with the piano part took ${t.toFixed(0)} s`);
    const s5 = await storedSong(page, id, (s) => !!s.transcription.separation);
    check('desktop: only the piano part was transcribed (singing and drums removed)', s5.transcription.separation?.pianoPart === true && s5.transcription.method === 'piano-specialist', s5.transcription.separation);
    check('desktop: the label says so', /Piano solo · high-accuracy piano model · singing and drums removed/.test(await dialog(page).getByTestId('analyze-done').innerText()));
    await dialog(page).getByRole('button', { name: 'See the new notes' }).click();
  }

  // 10. a MIDI song: nothing to analyze
  await page.goto(`${base}/studio/${encodeURIComponent(midiId)}`);
  await page.locator('canvas').first().waitFor();
  await openPanel(page, 'Notes');
  check('desktop: a MIDI song says where its notes came from', (await page.getByTestId('analyzed-as').innerText()) === 'Notes from the MIDI file');
  await page.getByRole('button', { name: 'Analyze again…' }).click();
  const nothing = dialog(page).getByTestId('analyze-nothing');
  await nothing.waitFor();
  check('desktop: a MIDI song has no recording to analyze, and offers importing one', /came straight from the MIDI file, so they’re already exact\. There’s no recording to analyze\./.test(await nothing.innerText()) && (await nothing.getByRole('button', { name: 'Import a recording' }).count()) === 1);
  await page.screenshot({ path: path.join(shots, 'desktop-midi.png') });
  await dialog(page).getByRole('button', { name: 'Close' }).last().click();

  check('desktop: no sideways scroll', (await sideScroll(page)) <= 0);
  check('desktop: no console errors', !errors.length, errors.slice(0, 5));
  await ctx.close();

  // ======== iPhone 14
  if (withPhone) {
    const { ctx: pctx, page: p, errors: perr } = await newPage({ ...devices['iPhone 14'], deviceScaleFactor: 2 });
    const pMidi = await importMidi(p);
    const pid = await importWav(p, wav);
    await openAnalyze(p);
    const warn = await dialog(p).getByText(/^May be slow on phones/).innerText().catch(() => '');
    check('iPhone: the piano model warning is Import’s', warn === 'May be slow on phones. Songs over 6 minutes might not work on phones with little memory.', warn);
    check('iPhone: no sideways scroll (options)', (await sideScroll(p)) <= 0);
    await p.screenshot({ path: path.join(shots, 'iphone-options.png') });
    await setBox(p, /High-accuracy piano model/, true);
    await runButton(p).click();
    await dialog(p).getByText(/^Analyzing “.+” again/).waitFor({ timeout: 10000 });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(shots, 'iphone-progress.png') });
    check('iPhone: "Keep this page open" while analyzing', await dialog(p).getByText('Keep this page open while it’s analyzing.').isVisible());
    await dialog(p).getByText('New notes are ready', { exact: true }).waitFor({ timeout: 10 * 60000 });
    await p.screenshot({ path: path.join(shots, 'iphone-done.png') });
    check('iPhone: no sideways scroll (result)', (await sideScroll(p)) <= 0);
    const ps = await storedSong(p, pid);
    check('iPhone: re-analyzed with the piano model, notes as played', ps.transcription.method === 'piano-specialist' && ps.noteLength === 'played');
    await dialog(p).getByRole('button', { name: 'See the new notes' }).click();
    const pcard = p.getByTestId('version-card');
    await pcard.scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(shots, 'iphone-version-card.png') });
    check('iPhone: the version card is shown', (await pcard.count()) === 1);
    // the reset toast (an unedited level)
    await p.getByRole('button', { name: /^Reset (Easy|Medium|Hard) to detected notes$/ }).click();
    await p.getByRole('alertdialog', { name: /is already as detected$/ }).waitFor({ timeout: 5000 });
    await p.screenshot({ path: path.join(shots, 'iphone-reset-toast.png') });
    check('iPhone: no sideways scroll (reset toast)', (await sideScroll(p)) <= 0);
    await dismissToasts(p);
    // the MIDI song
    await p.goto(`${base}/studio/${encodeURIComponent(pMidi)}`);
    await p.locator('canvas').first().waitFor();
    await openAnalyze(p);
    await dialog(p).getByTestId('analyze-nothing').waitFor();
    await p.screenshot({ path: path.join(shots, 'iphone-midi.png') });
    check('iPhone: no sideways scroll (MIDI song)', (await sideScroll(p)) <= 0);
    check('iPhone: no console errors', !perr.length, perr.slice(0, 5));
    await pctx.close();
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`screenshots: ${shots}`);
}
process.exit(failed ? 1 : 0);
