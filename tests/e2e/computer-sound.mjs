/**
 * The "Computer sound" tab of the Import page (src/pages/Import.tsx, src/lib/audio/tabAudio.ts) in
 * Playwright Chromium, production build served with the netlify.toml rules. The browser's
 * screen-sharing dialog can't be driven from a test, so getDisplayMedia is replaced by a stand-in
 * that "shares a tab" playing a few generated piano-range tones (no music files involved).
 *  - desktop: Start is greyed out until the rights box is ticked; recording, then "Stop & transcribe"
 *    imports the recording under the typed name and opens it in the Studio;
 *  - the browser's own "Stop sharing" also ends the recording and imports it;
 *  - sharing without sound says so, and nothing is imported;
 *  - the Home card and old /import/youtube links lead to the tab;
 *  - iPhone (390 px): the tab explains Screen Recording instead, with no sideways scrolling.
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/computer-sound.mjs --dist /tmp/p2v-dist [--port 5397] [--shots DIR]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium, devices } = require('playwright');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
const dist = path.resolve(opt('dist', 'dist'));
const port = Number(opt('port', '5397'));
const shots = opt('shots', null);
const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

/** In the page: getDisplayMedia "shares a tab" with tones (window.__shareSound = false: no sound). */
function fakeShare() {
  window.__shareSound = true;
  window.__shares = [];
  const md = navigator.mediaDevices;
  md.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    canvas.getContext('2d').fillRect(0, 0, 64, 36);
    const tracks = [...canvas.captureStream(5).getVideoTracks()];
    if (window.__shareSound) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      // C4 E4 G4 C5, 0.5 s each, over and over
      const freqs = [261.63, 329.63, 392.0, 523.25];
      for (let i = 0; i < 40; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = freqs[i % 4];
        const t = ctx.currentTime + 0.1 + i * 0.5;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.5, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.01, t + 0.45);
        o.connect(g).connect(dest);
        o.start(t);
        o.stop(t + 0.48);
      }
      tracks.push(...dest.stream.getAudioTracks());
    }
    const stream = new MediaStream(tracks);
    window.__shares.push(stream);
    return stream;
  };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  // ---- desktop
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: shots ? 2 : 1 });
  await ctx.addInitScript(fakeShare);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Record what’s playing/ }).click();
  await page.waitForURL(/\/import\?tab=computer$/);
  check('Home card opens the Computer sound tab', (await page.getByRole('tab', { name: 'Computer sound' }).getAttribute('aria-selected')) === 'true');

  const start = page.getByRole('button', { name: 'Start recording' });
  check('Start is greyed out until the rights box is ticked', await start.isDisabled());
  check('the terms note is shown', await page.getByText('Check the terms and conditions of the site or app you record from').isVisible());
  await page.getByLabel('Song name (optional)').fill('Tone test');
  await page.getByRole('checkbox', { name: /I own this music/ }).check();
  check('Start is available after ticking', await start.isEnabled());
  if (shots) await page.screenshot({ path: path.join(shots, 'computer-sound-desktop.png') });
  await start.click();
  await page
    .getByText(/Recording \d+:\d\d/)
    .waitFor({ timeout: 5000 })
    .catch(async (e) => {
      console.log(await page.evaluate(() => document.body.innerText.slice(0, 3000)));
      throw e;
    });
  await page.waitForTimeout(4000);
  if (shots) await page.screenshot({ path: path.join(shots, 'computer-sound-recording.png') });
  await page.getByRole('button', { name: 'Stop & transcribe' }).click();
  await page.waitForURL(/\/studio\/.+/, { timeout: 240000 });
  await page.waitForTimeout(1500);
  const song = await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const r = indexedDB.open('pianovision');
        r.onsuccess = () => {
          const g = r.result.transaction('songs').objectStore('songs').get(id);
          g.onsuccess = () => resolve(g.result ? { title: g.result.title, kind: g.result.source?.kind, notes: g.result.arrangements?.hard?.notes?.length ?? 0 } : null);
        };
      }),
    decodeURIComponent(page.url().split('/studio/')[1]),
  );
  check('"Stop & transcribe" imports the recording under the typed name', song?.title === 'Tone test' && song.kind === 'capture' && song.notes >= 4, song);
  const shares = await page.evaluate(() => window.__shares.map((s) => s.getTracks().map((t) => t.readyState)));
  check('sharing is stopped after recording', shares.flat().every((s) => s === 'ended'), shares);

  // the browser's own "Stop sharing" ends the recording too
  await page.goto(`${base}/import?tab=computer`);
  await page.getByRole('checkbox', { name: /I own this music/ }).check();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByText(/Recording \d+:\d\d/).waitFor({ timeout: 5000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const s = window.__shares.at(-1);
    for (const t of s.getTracks()) {
      t.stop();
      t.dispatchEvent(new Event('ended'));
    }
  });
  await page.waitForURL(/\/studio\/.+/, { timeout: 240000 });
  check('"Stop sharing" in the browser ends the recording and imports it', /\/studio\//.test(page.url()));

  // shared without sound
  await page.goto(`${base}/import?tab=computer`);
  await page.evaluate(() => (window.__shareSound = false));
  await page.getByRole('checkbox', { name: /I own this music/ }).check();
  await page.getByRole('button', { name: 'Start recording' }).click();
  const toast = page.getByText('No sound was shared.', { exact: false });
  await toast.first().waitFor({ timeout: 5000 }).catch(() => undefined);
  check('sharing without sound says so and records nothing', (await toast.count()) > 0 && (await page.getByRole('button', { name: 'Start recording' }).isVisible()) && /tab=computer/.test(page.url()));

  // old links
  for (const old of ['/import/youtube', '/import?tab=youtube']) {
    await page.goto(base + old);
    await page.waitForURL(/\/import\?tab=computer/);
    check(`${old} lands on Computer sound`, (await page.getByRole('tab', { name: 'Computer sound' }).getAttribute('aria-selected')) === 'true', page.url());
  }
  check('no page errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ---- iPhone
  const phone = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: shots ? 2 : 3 });
  const p2 = await phone.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(`${base}/import?tab=computer`, { waitUntil: 'networkidle' });
  const tabBtn = p2.getByRole('tab', { name: 'Computer sound' });
  check('iPhone: explains Screen Recording', await p2.getByText('iPhone and iPad can’t share another app’s sound with a website.').isVisible());
  check('iPhone: no Start button and no options it can’t use', (await p2.getByRole('button', { name: 'Start recording' }).count()) === 0 && (await p2.getByText('What kind of recording is it?').count()) === 0);
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('iPhone: no sideways scrolling', overflow <= 0, `overflow ${overflow}px`);
  check('iPhone: the tab is selected', (await tabBtn.getAttribute('aria-selected')) === 'true');
  if (shots) await p2.screenshot({ path: path.join(shots, 'computer-sound-iphone.png'), fullPage: true });
  await p2.getByRole('link', { name: 'Audio / Video' }).first().click();
  await p2.waitForURL(/tab=audio$/);
  await p2.waitForTimeout(500);
  const tabsNow = await p2.evaluate(() => [...document.querySelectorAll('[role=tab]')].map((t) => `${t.textContent?.trim()}:${t.getAttribute('aria-selected')}`));
  check('iPhone: the link opens the Audio / Video tab', tabsNow[0] === 'Audio / Video:true', tabsNow);
  check('no page errors (iPhone)', errors2.length === 0, errors2.join(' | '));
  await phone.close();
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
