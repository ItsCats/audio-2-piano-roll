/**
 * The import mini-games ("Play a game while you wait": Note Hopper, Key Snake) in Playwright Chromium
 * on a production build served with the exact netlify.toml headers (tests/e2e/isolation.server.py:
 * CSP, COOP/COEP).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/games.mjs --dist /tmp/p2v-dist [--port 5397] [--shots DIR] [--seconds 60] [--only iphone|desktop|landscape]
 *   node tests/e2e/games.mjs --dist /tmp/p2v-dist --perf [--runs 2] [--seconds 30] [--only desktop|iphone] [--throttle 4] [--dsf 1]
 *
 * Test (iPhone 14 and desktop 1440×900): a synthetic solo-piano WAV (made here) is imported with the
 * "High-accuracy piano model"; the "Play a game while you wait" button is not there at first and is by
 * 20 s; the picker opens (focus inside, Escape-safe), Note Hopper hops by tap / Space, Key Snake steers
 * by swipe, d-pad and arrow keys; when the import finishes the layer says "Your song is ready" and the
 * page stays on /import (no jump to the Studio mid-game) until "Open song". Desktop also: a failed
 * import (the model download made to fail after 22 s) says "The import failed" over the game. No
 * console errors, no CSP violations, the page stays cross-origin isolated, no sideways scroll, the
 * games' code is its own chunk loaded only when opened, and only new localStorage keys are written.
 * iPhone also: the whole layer blocks double-tap zoom. Desktop also: Space hops after clicking a
 * top-bar button. iPhone held sideways: Key Snake's board stays playable with the arrow pad beside it,
 * and games closed before the import ends let it open the Studio by itself as before.
 *
 * --perf: the same file imported back to back without and with a game running (taps keep Note Hopper
 * going, restarting after each crash), alternating, in one browser context after a warm-up import
 * (model cached). --throttle N: CPU throttling (CDP) on the page, as a slower phone.
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
const dist = opt('dist');
const port = Number(opt('port', '5397'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-games-')));
const only = opt('only');
const perf = flag('perf');
const seconds = Number(opt('seconds', perf ? '30' : '60'));
const runs = Number(opt('runs', '2'));
const throttle = Number(opt('throttle', '0'));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/games.mjs --dist BUILD_DIR [--perf] [--port N] [--shots DIR] [--seconds N] [--only iphone|desktop|landscape]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const { chromium, devices } = await import('playwright');

let failed = false;
const check = (name, ok, info) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
};

/** A solo-piano-like WAV (22.05 kHz mono): broken chords of decaying harmonic tones, `sec` long. */
function pianoWav(sec) {
  const sr = 22050;
  const n = Math.round(sec * sr);
  const pcm = new Float32Array(n);
  const prog = [
    [48, 60, 64, 67, 72],
    [45, 57, 60, 64, 69],
    [41, 53, 57, 60, 65],
    [43, 55, 59, 62, 67],
  ];
  const step = 0.25;
  for (let k = 0; k * step < sec; k++) {
    const chord = prog[Math.floor(k / 8) % prog.length];
    const pitch = chord[k % chord.length] + (k % 16 >= 8 ? 0 : 0);
    const f = 440 * 2 ** ((pitch - 69) / 12);
    const t0 = Math.round(k * step * sr);
    const len = Math.min(n - t0, Math.round(1.2 * sr));
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 3.2) * Math.min(1, t / 0.004);
      pcm[t0 + i] += 0.16 * env * (Math.sin(2 * Math.PI * f * t) + 0.45 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 2) + 0.2 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 4));
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  return buf;
}
const wavPath = path.join(os.tmpdir(), `p2v-games-${seconds}s.wav`);
if (!fs.existsSync(wavPath)) fs.writeFileSync(wavPath, pianoWav(seconds));

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (d) => (serverLog += d));
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 800));
if (server.exitCode !== null) {
  // e.g. the port is taken by another server: don't test someone else's build
  console.error(`the test server did not start on port ${port}:\n${serverLog}`);
  process.exit(2);
}
const browser = await chromium.launch();

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(opt('dsf', '2')) },
  iphone: { ...devices['iPhone 14'], deviceScaleFactor: 2 },
  // held sideways: 844×390 screen, about 750×340 left for the page
  'iphone-landscape': { ...devices['iPhone 14 landscape'], deviceScaleFactor: 2 },
};

async function newPage(contextOpts) {
  const ctx = await browser.newContext(contextOpts);
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    // frames the page asks for (to see the game's loop run and stop)
    window.__raf = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      window.__raf++;
      return raf(cb);
    };
    // frames the game drew (GameStage sets the canvas transform once per drawn frame; the import page has no other canvas)
    window.__draws = 0;
    const st = CanvasRenderingContext2D.prototype.setTransform;
    CanvasRenderingContext2D.prototype.setTransform = function (...a) {
      window.__draws++;
      return st.apply(this, a);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const scripts = [];
  page.on('request', (r) => r.resourceType() === 'script' && scripts.push(r.url()));
  return { ctx, page, errors, scripts };
}

const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const dropInput = (page) => page.locator('[role="button"] input[type="file"]').first();
const playBtn = (page) => page.getByRole('button', { name: 'Play a game while you wait' });
const dialog = (page) => page.getByRole('dialog');
const stageBox = async (page) => (await page.locator('[role="application"]').boundingBox());

async function chooseHighAccuracy(page) {
  await page.getByRole('radio', { name: 'Piano solo' }).click().catch(async () => page.getByText('Piano solo', { exact: true }).click());
  const box = page.getByRole('checkbox', { name: /High-accuracy piano model/ });
  if (!(await box.isChecked())) await box.check();
}

async function tapStage(page, dev, n, gapMs) {
  const b = await stageBox(page);
  for (let i = 0; i < n; i++) {
    if (dev === 'iphone') await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    else await page.keyboard.press('Space');
    await page.waitForTimeout(gapMs);
  }
}

async function swipe(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }] });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function startImport(page) {
  await page.goto(`${base}/import`);
  await page.getByRole('heading', { name: 'Import music', exact: true }).waitFor();
  await chooseHighAccuracy(page);
  const t0 = Date.now();
  await dropInput(page).setInputFiles(wavPath);
  return t0;
}

async function waitFor(fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function scenario(dev) {
  const { ctx, page, errors, scripts } = await newPage(DEVICES[dev]);
  const lsBefore = new Set();
  await page.goto(`${base}/import`);
  for (const k of await page.evaluate(() => Object.keys(localStorage))) lsBefore.add(k);
  const t0 = await startImport(page);
  await page.waitForTimeout(1500);
  check(`${dev}: no game button at the start of the import`, (await playBtn(page).count()) === 0);
  check(`${dev}: games' code not loaded before opening`, !scripts.some((u) => /GameOverlay/.test(u)));
  const shown = await waitFor(async () => (await playBtn(page).count()) > 0, 30000);
  const shownAt = (Date.now() - t0) / 1000;
  check(`${dev}: "Play a game while you wait" shown by 20 s`, !!shown && shownAt <= 22, { seconds: +shownAt.toFixed(1) });
  if (!shown) {
    await shot(page, `debug-no-game-button-${dev}`);
    console.log('import card:', await page.evaluate(() => document.querySelector('[data-import-card]')?.textContent ?? '(none)'), errors);
  }
  if (dev === 'iphone') await shot(page, 'import-card-phone');
  await playBtn(page).click();
  await dialog(page).waitFor();
  await page.getByRole('button', { name: /Note Hopper/ }).waitFor();
  check(`${dev}: games' code loaded as its own chunk on opening`, scripts.some((u) => /GameOverlay-.*\.js/.test(u)));
  await page.waitForTimeout(400); // the layer's fade-in
  check(`${dev}: focus moves into the games layer`, await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')));
  if (dev === 'iphone') await shot(page, 'picker-phone');
  else await shot(page, 'picker-desktop');

  // Note Hopper
  await page.getByRole('button', { name: /Note Hopper/ }).click();
  await page.locator('[role="application"]').waitFor();
  await page.waitForTimeout(300);
  if (dev === 'iphone') {
    // no double-tap zoom or pinch anywhere: every point of the layer sits in something with touch-action set
    const loose = await page.evaluate(() => {
      const out = [];
      for (let y = 5; y < innerHeight; y += 37)
        for (let x = 3; x < innerWidth; x += 29) {
          let el = document.elementFromPoint(x, y);
          let ok = false;
          for (; el; el = el.parentElement) {
            if (/none|manipulation/.test(getComputedStyle(el).touchAction)) ok = true;
            if (el.getAttribute('role') === 'dialog') break;
          }
          if (!ok) out.push([x, y]);
        }
      return out;
    });
    check(`${dev}: the whole layer blocks double-tap zoom (touch-action)`, loose.length === 0, loose.slice(0, 5));
  } else {
    // a mouse click on a top-bar button leaves the focus on the board: Space then hops (not that button again)
    await page.getByRole('button', { name: 'Turn sound off' }).click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    const soundStillOff = (await page.getByRole('button', { name: 'Turn sound on' }).count()) === 1;
    const hopped = (await page.getByText('Space, ↑ or click to hop').count()) === 0;
    check(`${dev}: Space hops after clicking the sound button`, soundStillOff && hopped, { soundStillOff, hopped });
    await page.getByRole('button', { name: 'Turn sound on' }).click();
    await waitFor(async () => (await page.getByText('Game over').count()) > 0, 15000);
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: 'Play again' }).click();
    await page.waitForTimeout(200);
  }
  const raf0 = await page.evaluate(() => window.__raf);
  await tapStage(page, dev, 6, 260);
  if (dev === 'iphone') await shot(page, 'note-hopper-phone');
  else await shot(page, 'note-hopper-desktop');
  const over = await waitFor(async () => (await page.getByText('Game over').count()) > 0, 15000);
  check(`${dev}: Note Hopper runs and ends with "Game over"`, !!over);
  const raf1 = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(1000);
  const raf2 = await page.evaluate(() => window.__raf);
  check(`${dev}: Note Hopper drew frames while playing and stopped its loop after`, raf1 - raf0 > 20 && raf2 - raf1 <= 3, { playing: raf1 - raf0, idle: raf2 - raf1 });
  // Pause (desktop: P key) while playing
  await page.getByRole('button', { name: 'Play again' }).click();
  await tapStage(page, dev, 1, 100);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByText('Paused', { exact: true }).waitFor();
  const rafP0 = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(800);
  const rafP1 = await page.evaluate(() => window.__raf);
  check(`${dev}: paused game asks for no frames`, rafP1 - rafP0 <= 3, { frames: rafP1 - rafP0 });
  await page.getByRole('button', { name: 'Resume' }).last().click();
  await waitFor(async () => (await page.getByText('Game over').count()) > 0, 15000);

  // Key Snake
  await page.getByRole('button', { name: 'All games' }).click();
  await page.getByRole('button', { name: /Key Snake/ }).click();
  await page.locator('[role="application"]').waitFor();
  await page.waitForTimeout(300);
  const b = await stageBox(page);
  if (dev === 'iphone') {
    await swipe(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 - 80 });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Right', exact: true }).tap();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Down', exact: true }).tap();
    await page.waitForTimeout(500);
    await shot(page, 'key-snake-phone');
  } else {
    for (const k of ['ArrowUp', 'ArrowRight', 'ArrowDown', 'KeyD']) {
      await page.keyboard.press(k);
      await page.waitForTimeout(450);
    }
    await shot(page, 'key-snake-desktop');
  }
  const playingSnake = (await page.getByText('Game over').count()) === 0;
  check(`${dev}: Key Snake runs`, playingSnake);
  await waitFor(async () => (await page.getByText('Game over').count()) > 0, 20000);
  check(`${dev}: Key Snake ends at the edge`, (await page.getByText('Game over').count()) > 0);
  // keep playing until the import is done
  const ready = await waitFor(async () => (await page.getByRole('alert').filter({ hasText: 'Your song is ready' }).count()) > 0, 10 * 60_000, 500);
  const doneAt = (Date.now() - t0) / 1000;
  check(`${dev}: "Your song is ready" shown over the game`, !!ready, { importSeconds: +doneAt.toFixed(1) });
  await page.waitForTimeout(1500);
  check(`${dev}: no jump to the Studio while the game is open`, /\/import/.test(page.url()), page.url());
  if (dev === 'iphone') await shot(page, 'song-ready');
  else await shot(page, 'song-ready-desktop');
  check(`${dev}: "Open song" and "Keep playing" offered`, (await page.getByRole('button', { name: 'Open song' }).count()) > 0 && (await page.getByRole('button', { name: 'Keep playing' }).count()) > 0);
  await page.getByRole('button', { name: 'Keep playing' }).click();
  await page.waitForTimeout(300);
  check(`${dev}: "Keep playing" returns to the game, song link stays in the top bar`, (await page.getByRole('button', { name: 'Open song' }).count()) === 1);
  await page.getByRole('button', { name: 'Turn sound off' }).click();
  check(`${dev}: sound toggle`, (await page.getByRole('button', { name: 'Turn sound on' }).getAttribute('aria-pressed')) === 'true');
  check(`${dev}: no sideways scroll`, (await sideScroll(page)) <= 0);
  check(`${dev}: cross-origin isolated`, await page.evaluate(() => crossOriginIsolated));
  if (dev === 'iphone') {
    // close → back on the import card (no jump), then open the song from there
    await page.getByRole('button', { name: 'Close games' }).first().click();
    await page.waitForTimeout(1200);
    check(`${dev}: closing returns to the import card`, /\/import/.test(page.url()) && (await page.getByRole('button', { name: 'Open in Piano Studio' }).count()) > 0);
    await page.getByRole('button', { name: 'Open in Piano Studio' }).click();
  } else {
    await page.getByRole('button', { name: 'Open song' }).click();
  }
  await page.waitForURL(/\/studio\//, { timeout: 15000 });
  check(`${dev}: the song opens in the Studio`, /\/studio\//.test(page.url()));
  await page.waitForTimeout(1500);
  const lsAfter = await page.evaluate(() => Object.keys(localStorage));
  const added = lsAfter.filter((k) => !lsBefore.has(k));
  // the import itself writes the settings and import choices; the games only their own new keys
  check(`${dev}: localStorage: only known keys added, the games' under piano2vision-game-*`, added.every((k) => k === 'pianovision-settings' || k === 'piano2vision-import-prefs' || k.startsWith('piano2vision-game-')), added);
  check(`${dev}: the sound setting was kept`, lsAfter.includes('piano2vision-game-sound'));
  const csp = await page.evaluate(() => window.__csp);
  check(`${dev}: no CSP violations`, csp.length === 0, csp);
  check(`${dev}: no console errors`, errors.length === 0, errors);
  await ctx.close();
}

/**
 * iPhone held sideways: Key Snake's board must stay playable (the arrow pad sits beside it); then the
 * games are closed while the import still runs, and the finished import opens the Studio by itself as
 * it did before games existed.
 */
async function landscapeScenario() {
  const dev = 'iphone-landscape';
  const { ctx, page, errors } = await newPage(DEVICES[dev]);
  const t0 = await startImport(page);
  await waitFor(async () => (await playBtn(page).count()) > 0, 30000);
  await playBtn(page).click();
  await page.getByRole('button', { name: /Key Snake/ }).click();
  await page.locator('[role="application"]').waitFor();
  await page.waitForTimeout(400);
  const b = await stageBox(page);
  const pad = await page.getByRole('button', { name: 'Right', exact: true }).boundingBox();
  check(`${dev}: Key Snake's board is big enough to play`, b.height >= 180 && b.width >= 300, { width: Math.round(b.width), height: Math.round(b.height) });
  check(`${dev}: the arrow pad sits beside the board`, !!pad && pad.x >= b.x + b.width, pad ?? undefined);
  await swipe(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 - 60 });
  await page.waitForTimeout(300);
  check(`${dev}: a swipe starts Key Snake`, (await page.getByText('Swipe or use the arrows to steer').count()) === 0);
  await page.getByRole('button', { name: 'Right', exact: true }).tap();
  await page.waitForTimeout(300);
  await shot(page, 'key-snake-phone-landscape');
  check(`${dev}: no sideways scroll`, (await sideScroll(page)) <= 0);
  // close while the import still runs → back on the card; when it finishes, off to the Studio as before
  await page.getByRole('button', { name: 'Close games' }).first().click();
  await page.waitForTimeout(500);
  check(`${dev}: closing returns to the import card`, (await dialog(page).count()) === 0 && (await page.locator('[data-import-card]').count()) === 1);
  const jumped = await waitFor(async () => /\/studio\//.test(page.url()), 10 * 60_000, 500);
  check(`${dev}: games closed before the end → the finished import opens the Studio by itself`, !!jumped, { seconds: +((Date.now() - t0) / 1000).toFixed(1) });
  check(`${dev}: no console errors`, errors.length === 0, errors);
  await ctx.close();
}

async function failScenario() {
  const { ctx, page, errors } = await newPage(DEVICES.desktop);
  // the model download fails after 22 s (a network drop)
  await page.route('**/models/piano-specialist/**', async (route) => {
    await new Promise((r) => setTimeout(r, 22000));
    await route.abort('failed').catch(() => undefined);
  });
  const t0 = await startImport(page);
  await waitFor(async () => (await playBtn(page).count()) > 0, 30000);
  await playBtn(page).click();
  await page.getByRole('button', { name: /Key Snake/ }).click();
  await page.keyboard.press('ArrowUp');
  const alert = await waitFor(async () => (await page.getByRole('alert').filter({ hasText: 'The import failed' }).count()) > 0, 120000, 500);
  check('desktop: a failed import says "The import failed" over the game', !!alert, { seconds: +((Date.now() - t0) / 1000).toFixed(1) });
  await shot(page, 'import-failed-desktop');
  await page.getByRole('button', { name: 'Back to import' }).click();
  await page.waitForTimeout(500);
  check('desktop: "Back to import" shows the error card', (await page.getByText('Import failed').count()) > 0 && (await dialog(page).count()) === 0);
  const unexpected = errors.filter((e) => !/piano-specialist|Failed to load resource|net::ERR_FAILED/.test(e));
  check('desktop (failed import): no unexpected console errors', unexpected.length === 0, unexpected);
  await ctx.close();
}

/** CPU seconds used so far by the browser this script started (all its processes and threads; Linux /proc). */
function browserCpuSeconds() {
  try {
    const kids = new Map();
    const comm = new Map();
    const cpu = new Map();
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const close = st.lastIndexOf(')');
        const f = st.slice(close + 2).split(' ');
        const ppid = Number(f[1]);
        comm.set(Number(d), st.slice(st.indexOf('(') + 1, close));
        cpu.set(Number(d), (Number(f[11]) + Number(f[12])) / 100);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(Number(d));
      } catch {
        /* exited */
      }
    }
    let total = 0;
    const stack = [...(kids.get(process.pid) ?? [])];
    while (stack.length) {
      const p = stack.pop();
      if (!/python/.test(comm.get(p) ?? '')) total += cpu.get(p) ?? 0;
      stack.push(...(kids.get(p) ?? []));
    }
    return total;
  } catch {
    return NaN;
  }
}

/** Import duration of the same file without and with a game running, alternating. */
async function perfRuns(dev) {
  const { ctx, page, errors } = await newPage(DEVICES[dev]);
  const cdp = await ctx.newCDPSession(page);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await cdp.send('Performance.enable');
  /** the page's main-thread busy time so far (s) */
  const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;
  const once = async (withGame) => {
    const t0 = await startImport(page);
    const busy0 = await busy();
    const cpu0 = browserCpuSeconds();
    let raf0 = 0;
    let draws0 = 0;
    let gameFrom = null;
    if (withGame) {
      if (!(await waitFor(async () => (await playBtn(page).count()) > 0, 60000, 100))) {
        await shot(page, 'debug-perf-no-game-button');
        console.log('import card:', await page.evaluate(() => `${location.pathname} ${document.querySelector('[data-import-card]')?.textContent ?? '(none)'}`));
      }
      gameFrom = (Date.now() - t0) / 1000;
      await playBtn(page).click();
      await page.getByRole('button', { name: /Note Hopper/ }).click();
      await page.locator('[role="application"]').waitFor();
      raf0 = await page.evaluate(() => window.__raf);
      draws0 = await page.evaluate(() => window.__draws);
    }
    const tGame = Date.now();
    let taps = 0;
    let lastTap = 0;
    // done: the import card (still in the page under the game) says so; polled the same way in both runs
    const isDone = () => page.evaluate(() => /Transcription complete/.test(document.querySelector('[data-import-card]')?.textContent ?? '')).catch(() => false);
    for (;;) {
      if (await isDone()) break;
      if (withGame && Date.now() - lastTap >= 300) {
        // keep the game going: hop, and start again after a crash
        await page.keyboard.press('Space');
        taps++;
        lastTap = Date.now();
      }
      await page.waitForTimeout(100);
      if (Date.now() - t0 > 20 * 60_000) throw new Error('import timed out');
    }
    const sec = (Date.now() - t0) / 1000;
    // share of the import's time the page's main thread was busy (the game, React, the harness's polling)
    const out = { withGame, seconds: +sec.toFixed(1), mainThreadBusy: `${(((await busy()) - busy0) / sec * 100).toFixed(1)}%`, cpuSeconds: +(browserCpuSeconds() - cpu0).toFixed(1) };
    out.browserCores = +(out.cpuSeconds / sec).toFixed(2);
    if (withGame) {
      const frames = (await page.evaluate(() => window.__raf)) - raf0;
      const draws = (await page.evaluate(() => window.__draws)) - draws0;
      const open = (Date.now() - tGame) / 1000;
      Object.assign(out, { gameFromSec: +gameFrom.toFixed(1), rafPerSec: +(frames / open).toFixed(1), drawsPerSec: +(draws / open).toFixed(1), taps });
      await page.getByRole('button', { name: 'Open song' }).first().waitFor();
      await page.getByRole('button', { name: 'Open song' }).first().click();
    }
    await page.waitForURL(/\/studio\//);
    await page.waitForTimeout(1500);
    return out;
  };
  console.log(`${dev}${throttle > 1 ? ` (CPU ${throttle}× slower)` : ''}: warm-up import (downloads the model once)…`);
  console.log(JSON.stringify(await once(false)));
  const results = [];
  for (let i = 0; i < runs; i++) {
    for (const g of i % 2 ? [true, false] : [false, true]) {
      const r = await once(g);
      results.push(r);
      console.log(JSON.stringify(r));
    }
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a = mean(results.filter((r) => !r.withGame).map((r) => r.seconds));
  const b = mean(results.filter((r) => r.withGame).map((r) => r.seconds));
  const ca = mean(results.filter((r) => !r.withGame).map((r) => r.cpuSeconds));
  const cb = mean(results.filter((r) => r.withGame).map((r) => r.cpuSeconds));
  const gameSec = mean(results.filter((r) => r.withGame).map((r) => r.seconds - r.gameFromSec));
  console.log(`PERF ${dev}${throttle > 1 ? ` throttle ${throttle}×` : ''}: without game ${a.toFixed(1)} s, with game ${b.toFixed(1)} s → ${(((b - a) / a) * 100).toFixed(1)}% (${seconds} s of audio, high-accuracy model, ${runs} runs each)`);
  // CPU time does not depend on how busy the machine is: the game's own cost, apart from contention
  console.log(`PERF ${dev}: browser CPU per import without game ${ca.toFixed(1)} s, with game ${cb.toFixed(1)} s → the game used ~${((cb - ca) / gameSec).toFixed(2)} cores while open (${(((cb - ca) / ca) * 100).toFixed(1)}% of the import's CPU time)`);
  if (errors.length) console.log('console errors:', errors);
  await ctx.close();
}

try {
  if (perf) {
    for (const dev of ['desktop', 'iphone']) if (!only || only === dev) await perfRuns(dev);
  } else {
    for (const dev of ['iphone', 'desktop']) if (!only || only === dev) await scenario(dev);
    if (!only || only === 'iphone' || only === 'landscape') await landscapeScenario();
    if (!only || only === 'desktop') await failScenario();
  }
  check('server: no duplicate COOP/COEP headers', !/DUPLICATE/.test(serverLog));
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
