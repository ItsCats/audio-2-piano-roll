/**
 * "Remove singing and drums" under Piano solo, as a user meets it, in Playwright Chromium on a PRODUCTION
 * build served with the exact netlify.toml headers (tests/e2e/isolation.server.py). The test song is made
 * here: the demo prelude's first 20 s on the app's own piano with a formant-synthesized singer on top at
 * the piano's level (tests/e2e/piano-part.ts, rendered once on a Vite dev server of this checkout).
 *
 *   npm run build
 *   TMPDIR=/dev/shm node tests/e2e/piano-part.mjs --dist dist [--port 5961] [--dev-port 5962] [--shots DIR]
 *
 * Desktop (1440x900, 16 GB reported):
 *   1. the option: shown under Piano solo ("Remove singing and drums", in this browser, with its limits
 *      line), off by default, enabled with the high-accuracy piano model too, remembered across a reload;
 *      Full song keeps "Separate vocals & drums"; shown on the Record and Computer sound tabs as well;
 *   2. ticked, normal model: the import shows "Removing singing and drums", the saved song records that the
 *      singing was removed (transcription.separation.pianoPart / singing), has no sung melody notes, few
 *      notes at the singer's pitches, and its notes match the prelude (onset F1, ±50 ms) at least
 *      F1_BAR.basicPitch (bars between the option off and on, see F1_BAR); the Studio shows "Singing removed";
 *   3. ticked, high-accuracy piano model: the same, F1 at least F1_BAR.pianoModel;
 *   4. Cancel while separating and while the piano model listens: the import stops within 5 s, no song saved;
 *   5. negative control: Full song + "Separate vocals & drums" on the same song still adds the sung melody;
 *   6. a separation that fails (the separation model cannot be downloaded): the whole recording is
 *      transcribed with the notice, nothing marked as removed.
 * iPhone 14 (memory-constrained): shown under Piano solo with the memory warning (and "The piano model runs
 * after it." with the piano model ticked), unticked by default, and old prefs that ticked it while a server
 * separated stay unticked on the phone; shown on the Record tab.
 * Both: no console errors, no sideways scroll.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const dist = path.resolve(opt('dist', path.join(root, 'dist')));
const port = Number(opt('port', '5961'));
const devPort = Number(opt('dev-port', '5962'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-piano-part-'));
const shots = opt('shots', tmp);
const timeoutMs = Number(opt('timeout-min', '8')) * 60000;
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/piano-part.mjs --dist BUILD_DIR [--port N] [--dev-port N] [--shots DIR]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
/**
 * Minimum onset F1 vs the prelude, and most wrong notes per second at the singer's pitch. Measured on this
 * song (2026-11-14, 3 WASM threads): normal model 0.851 / 0.65 per s on the whole mix (option off), 0.911 /
 * 0 with the option, 0.930 on the clean piano; piano model 0.740 / 1.55 per s on the mix, 0.861 / 0.15 with
 * the option, 0.883 / 0.15 on the clean piano (it hears a few ghost notes in the app's piano samples, some at
 * the singer's pitches). The bars sit between "option off" and "option on".
 */
const F1_BAR = { basicPitch: 0.87, pianoModel: 0.8 };
const SUNG_BAR = { basicPitch: 0.15, pianoModel: 0.4 };
const LABEL = /Remove singing and drums/;
const LIMITS = 'Guitars, synths and other instruments stay in: the separation can’t tell them apart from the piano.';

const { chromium, devices } = await import('playwright');
let failed = false;
const check = (ok, label, detail = '') => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
};
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// ---- the test song (rendered on a dev server of this checkout: the app's piano engine)
let song;
{
  const dev = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port: devPort, strictPort: true }, logLevel: 'error', ...(process.env.ACC_VITE_CACHE ? { cacheDir: path.resolve(process.env.ACC_VITE_CACHE) } : {}) });
  await dev.listen();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${devPort}/tests/e2e/piano-part.html`);
    await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
    song = await page.evaluate(() => window.render(20, 0));
    await page.close();
  } finally {
    await dev.close();
  }
}
const wavPath = path.join(tmp, 'Sung prelude.wav');
fs.writeFileSync(wavPath, Buffer.from(song.wav, 'base64'));
console.log(`test song  ${song.seconds} s, ${song.reference.length} piano notes, ${song.sung.length} sung notes`);

/** onset F1 (same pitch, ±50 ms, one to one) and wrong notes at the singer's pitch per second */
function score(notes) {
  const est = notes.map((n) => [n.midi, n.start]);
  const used = new Set();
  let tp = 0;
  const matched = new Set();
  for (const [m, t] of song.reference) {
    let best = -1;
    let bd = 0.05;
    est.forEach(([em, et], j) => {
      if (em !== m || used.has(j)) return;
      const d = Math.abs(et - t);
      if (d <= bd) {
        bd = d;
        best = j;
      }
    });
    if (best >= 0) {
      used.add(best);
      matched.add(best);
      tp++;
    }
  }
  const p = est.length ? tp / est.length : 0;
  const r = tp / song.reference.length;
  const sungWrong = est.filter(([m, t], j) => !matched.has(j) && song.sung.some(([s, ln, sm]) => sm === m && t >= s - 0.05 && t <= s + ln)).length;
  return { f1: p + r ? (2 * p * r) / (p + r) : 0, p, r, n: est.length, sungPerS: sungWrong / song.seconds };
}

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

async function open(contextOpts, initPrefs, mem = 16) {
  const ctx = await browser.newContext(contextOpts);
  if (initPrefs) await ctx.addInitScript((p) => localStorage.getItem('piano2vision-import-prefs') ?? localStorage.setItem('piano2vision-import-prefs', p), JSON.stringify(initPrefs));
  if (mem) await ctx.addInitScript((m) => Object.defineProperty(navigator, 'deviceMemory', { get: () => m }), mem);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base + '/import');
  await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
  return { ctx, page, errors };
}
const preset = (page, name) => page.getByRole('radiogroup', { name: 'Detection preset' }).getByRole('radio', { name }).click();
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const box = (page) => page.getByRole('checkbox', { name: LABEL });
/** the option's whole box (label, description, limits line, warnings) */
const optionCard = (page) => box(page).locator('xpath=ancestor::div[1]');
const modelBox = (page) => page.getByRole('checkbox', { name: /^High-accuracy piano model/ });
const prefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('piano2vision-import-prefs') ?? '{}'));
const songCount = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('pianovision');
        r.onsuccess = () => {
          const c = r.result.transaction('songs').objectStore('songs').count();
          c.onsuccess = () => resolve(c.result);
        };
        r.onerror = () => resolve(-1);
      }),
  );
const readSong = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const r = indexedDB.open('pianovision');
        r.onsuccess = () => {
          const g = r.result.transaction('songs').objectStore('songs').get(id);
          g.onsuccess = () => {
            const s = g.result;
            resolve(s ? { transcription: s.transcription, base: s.base.map((n) => ({ midi: n.midi, start: n.start, role: n.role ?? null })), hard: s.arrangements.hard.notes.map((n) => ({ midi: n.midi, start: n.start, role: n.role ?? null })) } : null);
          };
        };
      }),
    id,
  );
const upload = (page) => page.locator('input[type=file]:not([data-testid])').first().setInputFiles(wavPath);
const card = (page) => page.locator('[data-import-card]');

/** Import the test song from the file tab and wait for the Studio; returns the saved song and what the card showed. */
async function importSong(page) {
  const seen = new Set();
  await upload(page);
  const t0 = Date.now();
  while (!/\/studio\//.test(page.url())) {
    if (Date.now() - t0 > timeoutMs) throw new Error('import timed out');
    const text = await card(page).innerText().catch(() => '');
    for (const l of text.split('\n')) if (l.trim()) seen.add(l.trim().replace(/\d+/g, '#'));
    if (/Import failed/.test(text)) throw new Error(`import failed: ${text}`);
    await page.waitForTimeout(250);
  }
  const id = decodeURIComponent(page.url().split('/studio/')[1]);
  await page.waitForTimeout(800);
  return { id, song: await readSong(page, id), seen: [...seen], ms: Date.now() - t0 };
}

/** Start an import and cancel it once the card shows `when`. */
async function cancelDuring(page, when) {
  const before = await songCount(page);
  await upload(page);
  const t0 = Date.now();
  for (;;) {
    const text = await card(page).innerText().catch(() => '');
    if (when.test(text)) break;
    if (/Import failed|Transcription complete/.test(text) || /\/studio\//.test(page.url())) return { reached: false, text };
    if (Date.now() - t0 > timeoutMs) return { reached: false, text: 'timeout' };
    await page.waitForTimeout(100);
  }
  const c0 = Date.now();
  await card(page).getByRole('button', { name: 'Cancel' }).click();
  await card(page).waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  const gone = Date.now() - c0;
  // a few seconds more: nothing may finish behind the user's back
  await page.waitForTimeout(4000);
  return { reached: true, goneMs: gone, gone: (await card(page).count()) === 0, saved: (await songCount(page)) - before, url: page.url() };
}

try {
  // ---- desktop
  {
    const { ctx, page, errors } = await open({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await preset(page, 'Piano solo');
    await box(page).waitFor();
    const opt0 = await box(page).locator('xpath=ancestor::label').innerText();
    check((await box(page).isEnabled()) && !(await box(page).isChecked()), 'desktop    ', 'Piano solo: "Remove singing and drums" shown, enabled, off by default');
    check(/in this browser/.test(opt0) && opt0.includes(LIMITS) && /so the singing isn’t played on the piano/.test(opt0), 'desktop    ', 'description, badge and limits line');
    check((await page.getByRole('checkbox', { name: /Separate vocals/ }).count()) === 0, 'desktop    ', 'no "Separate vocals & drums" under Piano solo');
    await modelBox(page).check();
    check((await box(page).isEnabled()) && !/Not used with the high-accuracy piano model/.test(await page.content()), 'desktop    ', 'enabled with the high-accuracy piano model');
    await modelBox(page).uncheck();
    await box(page).check();
    const p1 = await prefs(page);
    check(p1.separate?.piano === true && p1.engine?.piano === 'browser', 'desktop    ', `remembered ${JSON.stringify(p1)}`);
    await box(page).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    await page.screenshot({ path: path.join(shots, 'piano-part-option-desktop.png') });
    await optionCard(page).screenshot({ path: path.join(shots, 'piano-part-option-desktop-card.png') });
    await page.reload();
    await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
    check(await box(page).isChecked(), 'desktop    ', 'still ticked after a reload');
    await preset(page, 'Full song');
    check((await page.getByRole('checkbox', { name: /Separate vocals/ }).count()) === 1 && (await box(page).count()) === 0, 'desktop    ', 'Full song: "Separate vocals & drums" as before');
    await preset(page, 'Piano solo');
    // the other tabs
    await page.goto(base + '/import?tab=record');
    await box(page).waitFor();
    check(await box(page).isChecked(), 'record tab ', 'shown (and the Piano solo choice) under the piano-model box');
    await page.goto(base + '/import?tab=computer');
    await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
    check((await box(page).count()) === 1, 'computer   ', 'shown under Piano solo');
    check((await sideScroll(page)) <= 0, 'desktop    ', 'no sideways scroll');

    // 2. normal model
    await page.goto(base + '/import');
    await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
    const a = await importSong(page);
    const sa = score(a.song.base);
    const sep = a.song.transcription.separation;
    console.log(`normal     ${a.song.base.length} notes, F1 ${sa.f1.toFixed(3)} (P ${sa.p.toFixed(2)} R ${sa.r.toFixed(2)}), sung ${sa.sungPerS.toFixed(2)}/s, ${(a.ms / 1000).toFixed(0)} s, ${JSON.stringify(sep)}`);
    check(a.seen.some((l) => /^Removing singing and drums/.test(l)), 'normal     ', 'the card said "Removing singing and drums"');
    check(sep?.pianoPart === true && sep.singing === true && sep.bassRemoved === true && sep.engine === 'scnet-browser' && a.song.transcription.method === 'basic-pitch', 'normal     ', 'saved: singing removed (pianoPart, singing, bassRemoved)');
    check(!a.song.base.some((n) => n.role === 'melody') && !a.song.hard.some((n) => n.role === 'melody'), 'normal     ', 'no sung melody notes');
    check(sa.f1 >= F1_BAR.basicPitch, 'normal     ', `F1 ${sa.f1.toFixed(3)} >= ${F1_BAR.basicPitch}`);
    check(sa.sungPerS < SUNG_BAR.basicPitch, 'normal     ', `${sa.sungPerS.toFixed(3)} wrong notes/s at the singer's pitch < ${SUNG_BAR.basicPitch}`);
    await page.getByRole('button', { name: 'Notes' }).first().click().catch(() => page.getByText('Notes', { exact: true }).first().click());
    const badge = page.getByText('Singing removed', { exact: true });
    await badge.waitFor({ timeout: 10000 }).catch(() => undefined);
    check((await badge.count()) > 0 && (await page.getByText('Drums removed', { exact: true }).count()) > 0, 'studio     ', '"Singing removed" and "Drums removed" badges');
    if (await badge.count()) {
      await badge.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shots, 'piano-part-studio-badge.png') });
    }

    // 3. the high-accuracy piano model
    await page.goto(base + '/import');
    await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
    await modelBox(page).check();
    check(await box(page).isChecked(), 'piano model', 'the option stays ticked with the piano model');
    const b = await importSong(page);
    const sb = score(b.song.base);
    const sepb = b.song.transcription.separation;
    console.log(`piano model ${b.song.base.length} notes, F1 ${sb.f1.toFixed(3)} (P ${sb.p.toFixed(2)} R ${sb.r.toFixed(2)}), sung ${sb.sungPerS.toFixed(2)}/s, ${(b.ms / 1000).toFixed(0)} s, ${JSON.stringify(sepb)}`);
    check(b.seen.some((l) => /^Removing singing and drums/.test(l)) && b.seen.some((l) => /Listening to the piano/.test(l)), 'piano model', 'separated first, then the piano model listened');
    check(b.song.transcription.method === 'piano-specialist' && sepb?.pianoPart === true && sepb.singing === true, 'piano model', 'saved: piano model, singing removed');
    check(!b.song.base.some((n) => n.role === 'melody'), 'piano model', 'no sung melody notes');
    check(sb.f1 >= F1_BAR.pianoModel, 'piano model', `F1 ${sb.f1.toFixed(3)} >= ${F1_BAR.pianoModel}`);
    check(sb.sungPerS < SUNG_BAR.pianoModel, 'piano model', `${sb.sungPerS.toFixed(3)} wrong notes/s at the singer's pitch < ${SUNG_BAR.pianoModel}`);
    check(!(b.song.transcription.warnings ?? []).some((w) => /not used/.test(w)), 'piano model', 'no "not used" warning');

    // 4. cancel
    await page.goto(base + '/import');
    await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
    const c1 = await cancelDuring(page, /Removing singing and drums: part/);
    check(c1.reached && c1.gone && c1.goneMs <= 5000 && c1.saved === 0 && /\/import/.test(c1.url), 'cancel     ', `while separating ${JSON.stringify(c1)}`);
    const c2 = await cancelDuring(page, /Listening to the piano/);
    check(c2.reached && c2.gone && c2.goneMs <= 5000 && c2.saved === 0 && /\/import/.test(c2.url), 'cancel     ', `while the piano model listens ${JSON.stringify(c2)}`);
    await modelBox(page).uncheck();

    // 5. negative control: Full song + "Separate vocals & drums" still follows the singer
    await preset(page, 'Full song');
    const sepFull = page.getByRole('checkbox', { name: /Separate vocals/ });
    if (!(await sepFull.isChecked())) await sepFull.check();
    const f = await importSong(page);
    const melody = f.song.base.filter((n) => n.role === 'melody').length;
    check(melody > 0 && f.song.transcription.separation?.vocals === true && !f.song.transcription.separation?.pianoPart, 'full song  ', `negative control: ${melody} sung melody notes, "Vocals separated"`);
    await page.goto(base + '/import');
    await preset(page, 'Piano solo');
    check((await sideScroll(page)) <= 0, 'desktop    ', 'no sideways scroll');
    check(!errors.length, 'desktop    ', errors.length ? `console errors: ${errors.slice(0, 3).join(' | ')}` : 'no console errors');
    await ctx.close();
  }
  // ---- 6. a separation that fails: the whole recording, with the notice
  {
    const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 860 } }, { separate: { piano: true }, engine: { piano: 'browser' } });
    await ctx.route('**/models/scnet/**', (r) => r.abort());
    await preset(page, 'Piano solo');
    check(await box(page).isChecked(), 'failure    ', 'ticked from the prefs');
    const g = await importSong(page);
    const w = g.song.transcription.warnings ?? [];
    check(w.some((x) => /^The singing could not be removed \(.+\), so the whole recording was turned into notes: some notes may come from the singing\./.test(x)), 'failure    ', `notice: ${w[0] ?? '(none)'}`);
    check(!g.song.transcription.separation && g.song.base.length > 0, 'failure    ', `the whole recording was transcribed (${g.song.base.length} notes), nothing marked as removed`);
    // (the failed model download is the only console error expected here)
    const other = errors.filter((e) => !/scnet|separation|Failed to fetch|ERR_FAILED|net::/i.test(e));
    check(!other.length, 'failure    ', other.length ? `console errors: ${other.slice(0, 3).join(' | ')}` : 'no other console errors');
    await ctx.close();
  }
  // ---- iPhone 14, with a "yes" given while a server separated
  {
    const { ctx, page, errors } = await open({ ...devices['iPhone 14'], deviceScaleFactor: 2 }, { separate: { piano: true }, engine: { piano: 'server' } }, 0);
    await preset(page, 'Piano solo');
    await box(page).waitFor();
    await box(page).scrollIntoViewIfNeeded();
    const t = await box(page).locator('xpath=ancestor::label').innerText();
    check(!(await box(page).isChecked()) && (await box(page).isEnabled()), 'iPhone     ', 'shown, unticked (the server-time "yes" does not carry over), can be ticked');
    check(/May run out of memory on this device\./.test(t) && t.includes(LIMITS), 'iPhone     ', 'memory warning and limits line');
    await modelBox(page).check();
    const t2 = await box(page).locator('xpath=ancestor::label').innerText();
    check(/The piano model runs after it\./.test(t2), 'iPhone     ', '"The piano model runs after it." with the piano model ticked');
    await optionCard(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, 'piano-part-option-phone.png') });
    await optionCard(page).screenshot({ path: path.join(shots, 'piano-part-option-phone-card.png') });
    check((await sideScroll(page)) <= 0, 'iPhone     ', 'no sideways scroll (import page)');
    await page.goto(base + '/import?tab=record');
    await box(page).waitFor();
    check((await box(page).count()) === 1 && (await sideScroll(page)) <= 0, 'iPhone     ', 'Record tab: shown, no sideways scroll');
    await page.screenshot({ path: path.join(shots, 'piano-part-record-phone.png'), fullPage: true });
    check(!errors.length, 'iPhone     ', errors.length ? `console errors: ${errors.slice(0, 3).join(' | ')}` : 'no console errors');
    await ctx.close();
  }
} catch (err) {
  failed = true;
  console.error('FAIL', err.stack ?? err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(`screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
