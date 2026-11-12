/**
 * Studio full screen (src/components/studio/FullscreenStage.tsx) in Playwright Chromium.
 *
 *   node tests/e2e/fullscreen.mjs [--port 5391] [--shots DIR] [--dist BUILD_DIR --dist-port 5392]
 *
 * iPhone 14 emulation, with the Fullscreen API removed as on iPhone Safari (the fixed-layer path),
 * portrait then landscape:
 *  - the "Full screen" button is on the piano roll; entering covers the app: no sidebar, bottom
 *    tabs, Studio header or transport; the canvas fills the viewport (CSS size = innerWidth ×
 *    innerHeight, backing store = CSS size × the renderer's pixel ratio, no stretching); no page
 *    scroll; edit mode is switched off;
 *  - the one-time portrait hint shows and stays dismissed (localStorage);
 *  - while playing the controls hide after ~3 s; a tap on the notes brings them back and does not
 *    seek, edit or pause, also when it lands where a hidden control (Exit, Pause, speed) sits;
 *  - the bottom controls sit above the on-screen keys, so a paused user sees and can tap every key;
 *  - the system back gesture leaves full screen and stays on the song;
 *  - rotating re-lays out the canvas; exiting restores the layout; leaving the page while full
 *    screen restores the shell and the page's overflow.
 * iPad Pro 11: the real Fullscreen API, and no "turn sideways" hint (that is for phones).
 * Desktop Chromium: the real Fullscreen API (document.fullscreenElement is the stage), F toggles,
 * Esc exits, the mouse pointer hides with the controls, Tab stays inside, F does nothing while a
 * dialog is open.
 * Sheet music view (desktop and iPhone): its "Full screen" button sits in the sheet's own toolbar
 * and can be clicked (nothing covers it, and no second button under the toolbar); in full screen
 * the toolbar (Smaller / Bigger / Follow) sits below the "Exit full screen" row, not under it; on
 * exit focus returns to the button. On the overlay's position bar ← seeks once and Alt / Cmd + ←
 * is left to the browser.
 * With --dist, a production build is served with the netlify.toml headers (tests/e2e/isolation.server.py)
 * and the web app manifest, its icons and the apple-touch-icon load without CSP violations while
 * the page stays cross-origin isolated.
 * Screenshots go to --shots (default: the OS temp folder), never into the repo.
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
const port = Number(opt('port', '5391'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-fullscreen-')));
const dist = opt('dist');
const distPort = Number(opt('dist-port', '5392'));
fs.mkdirSync(shots, { recursive: true });
const { chromium, devices } = await import('playwright');

let failed = 0;
const ok = (cond, msg, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!cond) failed++;
  return cond;
};
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** iPhone Safari: no element full screen */
const NO_FULLSCREEN_API = () => {
  Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true });
  delete Element.prototype.requestFullscreen;
  delete Element.prototype.webkitRequestFullscreen;
};

/** canvas, stage and page geometry, and what is drawn at a few points */
const measure = () => {
  const canvas = document.querySelector('canvas[aria-label="Piano roll"]');
  const stage = document.querySelector('[data-fullscreen]');
  const r = canvas.getBoundingClientRect();
  const visible = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(el).display === 'none') return false;
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (el === hit || el.contains(hit));
  };
  const controls = stage?.querySelector(':scope > [data-fs-controls]');
  const bar = document.querySelector('[data-fs-controls] [aria-label="Song position"]')?.parentElement?.parentElement;
  return {
    barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
    canvasTop: r.top,
    mode: stage?.dataset.fullscreen,
    fsElementIsStage: document.fullscreenElement === stage && !!stage,
    inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    css: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10),
    backing: [canvas.width, canvas.height],
    keysTop: Number(canvas.dataset.keysTop),
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, scrollX, scrollY],
    htmlOverflow: document.documentElement.style.overflow,
    bodyOverflow: document.body.style.overflow,
    navVisible: [...document.querySelectorAll('nav[aria-label="Main"]')].some((n) => n.getBoundingClientRect().height > 0 && getComputedStyle(n).display !== 'none'),
    headerVisible: visible('input[aria-label="Song title"]'),
    transportVisible: visible('[aria-label="Song position (shift-drag to set a loop)"]'),
    controlsShown: controls ? controls.getAttribute('aria-hidden') !== 'true' : null,
    controlsOpacity: controls ? Number(getComputedStyle(controls).opacity) : null,
    hint: !!document.querySelector('[role="status"]')?.textContent?.includes('Turn your phone sideways'),
    hintKey: (() => {
      try {
        return localStorage.getItem('piano2vision-fullscreen-hint');
      } catch {
        return 'error';
      }
    })(),
    editMode: window.__studio?.getState().editMode,
    playing: window.__pv?.getPlayer().isPlaying,
    time: window.__pv?.getPlayer().getTime(),
  };
};

/** canvas fills the viewport with a sharp, unstretched backing store at the screen's pixel ratio */
function checkFills(m, label) {
  const [w, h] = m.inner;
  const pr = Math.min(3, m.dpr);
  ok(Math.abs(m.css[2] - w) <= 1 && Math.abs(m.css[3] - h) <= 1 && m.css[0] === 0 && m.css[1] === 0, `${label}: canvas fills the viewport`, { css: m.css, inner: m.inner });
  ok(Math.abs(m.backing[0] - m.css[2] * pr) <= 1 && Math.abs(m.backing[1] - m.css[3] * pr) <= 1, `${label}: backing store = CSS size × ${pr} (device ${m.dpr}×)`, { backing: m.backing });
  ok(m.scroll[0] <= w && m.scroll[2] === 0 && m.scroll[3] === 0, `${label}: no page scroll`, { scroll: m.scroll });
  ok(!m.navVisible && !m.headerVisible && !m.transportVisible, `${label}: no app navigation, Studio header or transport visible`, { nav: m.navVisible, header: m.headerVisible, transport: m.transportVisible });
}

async function openDemo(page, base) {
  await page.goto(`${base}/studio`);
  await page.getByRole('button', { name: 'Demo' }).click();
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 60000 });
  await page.getByRole('slider', { name: 'Song position (shift-drag to set a loop)' }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.__pv && window.__studio, null, { timeout: 30000 });
  await sleep(800);
}

async function waitControls(page, shown, timeout = 6000) {
  await page.waitForFunction(
    (s) => document.querySelector('[data-fullscreen] > [data-fs-controls]')?.getAttribute('aria-hidden') === String(!s),
    shown,
    { timeout },
  );
  await sleep(400); // fade
}

async function iphone(browser, base) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'] });
  await ctx.addInitScript(NO_FULLSCREEN_API);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => ok(false, `iPhone page error: ${e.message}`));
  await openDemo(page, base);

  // normal Studio: where the button is
  const btn = page.getByRole('button', { name: 'Full screen' });
  const box = await btn.boundingBox();
  ok(!!box && box.height >= 44 && box.width >= 44, 'iPhone: "Full screen" button on the piano roll, at least 44 px', box);
  await shot(page, 'iphone14-portrait-studio');
  const before = await page.evaluate(measure);
  ok(before.navVisible && before.headerVisible && before.transportVisible, 'iPhone: normal Studio shows navigation, header and transport');

  // enter (edit mode on first: full screen switches it off)
  await page.evaluate(() => window.__studio.getState().setEditMode(true));
  await btn.tap();
  await page.waitForSelector('[data-fullscreen="pseudo"]');
  await sleep(500);
  let m = await page.evaluate(measure);
  ok(m.mode === 'pseudo', 'iPhone portrait: fixed full-viewport layer (no Fullscreen API)', m.mode);
  ok(m.editMode === false, 'iPhone: entering full screen leaves edit mode');
  ok(m.htmlOverflow === 'hidden', 'iPhone: page scroll locked while full screen');
  checkFills(m, 'iPhone portrait');
  ok(m.hint && m.hintKey === null, 'iPhone portrait: one-time "turn sideways" hint shows');
  ok(m.controlsShown && m.controlsOpacity === 1, 'iPhone portrait: controls shown while paused');
  await shot(page, 'iphone14-portrait-hint');
  for (const name of ['Exit full screen', 'Play']) {
    const b = await page.getByRole('button', { name, exact: true }).boundingBox();
    ok(!!b && b.height >= 44 && b.width >= 44, `iPhone: "${name}" target ≥ 44 px`, b && [b.width, b.height]);
  }
  ok(m.barBottom !== null && m.barBottom <= m.canvasTop + m.keysTop + 1, 'iPhone portrait: bottom controls sit above the piano keys', { barBottom: m.barBottom, keysTop: m.keysTop });
  ok(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [m.inner[0] / 2, m.keysTop + (m.inner[1] - m.keysTop) * 0.5]), 'iPhone portrait (paused): a tap on the keys reaches the keys');
  const sb = await page.getByRole('slider', { name: 'Song position', exact: true }).boundingBox();
  ok(!!sb && sb.height >= 44, 'iPhone: seek bar touch area ≥ 44 px tall', sb && [Math.round(sb.width), sb.height]);

  await page.getByRole('button', { name: 'Dismiss' }).tap();
  m = await page.evaluate(measure);
  ok(!m.hint && m.hintKey === 'dismissed', 'iPhone: hint dismissed and remembered');

  // speed from the overlay
  await page.getByRole('button', { name: /^Playback speed/ }).tap();
  await page.getByRole('button', { name: '0.75×', exact: true }).tap();
  ok(await page.getByRole('button', { name: 'Playback speed 0.75×' }).isVisible(), 'iPhone: speed set to 0.75× from full screen');
  await page.getByRole('button', { name: /^Playback speed/ }).tap();
  await page.getByRole('button', { name: '1×', exact: true }).tap();
  await shot(page, 'iphone14-portrait-controls');

  // play: controls hide, a tap on the notes shows them again without seeking or editing
  await page.getByRole('button', { name: 'Play', exact: true }).tap();
  await page.waitForFunction(() => window.__pv.getPlayer().isPlaying, null, { timeout: 30000 });
  await waitControls(page, false);
  m = await page.evaluate(measure);
  ok(!m.controlsShown && m.controlsOpacity === 0 && m.playing, 'iPhone portrait: controls hide ~3 s after the last touch while playing');
  await shot(page, 'iphone14-portrait-hidden');
  const t0 = await page.evaluate(() => window.__pv.getPlayer().getTime());
  const sel0 = await page.evaluate(() => window.__studio.getState().selection.size);
  const [w, h] = m.inner;
  await page.touchscreen.tap(w / 2, h * 0.3);
  await sleep(150);
  m = await page.evaluate(measure);
  const t1 = m.time;
  ok(m.controlsShown, 'iPhone portrait: tap on the notes shows the controls');
  ok(m.playing && t1 >= t0 && t1 - t0 < 1.2, 'iPhone: that tap does not seek or pause', { t0, t1 });
  ok(!m.editMode && (await page.evaluate(() => window.__studio.getState().selection.size)) === sel0, 'iPhone: that tap does not edit');

  // keys still play while the controls are hidden
  await waitControls(page, false);
  m = await page.evaluate(measure);
  await page.touchscreen.tap(w / 2, m.keysTop + (h - m.keysTop) * 0.8);
  await sleep(150);
  m = await page.evaluate(measure);
  ok(!m.controlsShown, 'iPhone: tapping the piano keys plays them without bringing up the controls');

  // a revealing tap where a hidden control sits presses nothing
  await ghostTaps(page, 'iPhone portrait');

  // rotate while playing
  await page.setViewportSize({ width: 844, height: 390 });
  await sleep(700);
  m = await page.evaluate(measure);
  ok(m.mode === 'pseudo', 'iPhone landscape: still full screen after rotating');
  checkFills(m, 'iPhone landscape');
  ok(!m.hint, 'iPhone landscape: no rotate hint');
  await waitControls(page, false);
  await page.touchscreen.tap(422, 120);
  await waitControls(page, true, 2000);
  m = await page.evaluate(measure);
  ok(m.barBottom !== null && m.barBottom <= m.canvasTop + m.keysTop + 1, 'iPhone landscape: bottom controls sit above the piano keys', { barBottom: m.barBottom, keysTop: m.keysTop });
  await waitControls(page, false);
  await ghostTaps(page, 'iPhone landscape');
  await waitControls(page, false);
  await page.touchscreen.tap(422, 120);
  await waitControls(page, true, 2000);
  await shot(page, 'iphone14-landscape-controls');
  await waitControls(page, false);
  ok(!(await page.evaluate(measure)).controlsShown, 'iPhone landscape: controls hide again while playing');
  await shot(page, 'iphone14-landscape-hidden');

  // pause from the overlay: controls stay
  await page.touchscreen.tap(422, 120);
  await waitControls(page, true, 2000);
  await page.getByRole('button', { name: 'Pause', exact: true }).tap();
  await sleep(3800);
  m = await page.evaluate(measure);
  ok(!m.playing && m.controlsShown, 'iPhone: paused → controls stay visible');
  ok(m.barBottom <= m.canvasTop + m.keysTop + 1 && (await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [200, m.keysTop + (m.inner[1] - m.keysTop) * 0.5])), 'iPhone landscape (paused): every key visible and tappable', { barBottom: m.barBottom, keysTop: m.keysTop });

  // exit restores the layout
  await page.getByRole('button', { name: 'Exit full screen' }).tap();
  await page.waitForSelector('[data-fullscreen="off"]');
  await sleep(500);
  m = await page.evaluate(measure);
  ok(m.navVisible && m.headerVisible && m.transportVisible && m.htmlOverflow === '' && m.bodyOverflow === '', 'iPhone: exit restores navigation, header, transport and page overflow', m);
  ok(m.css[3] < m.inner[1] - 100 && Math.abs(m.backing[1] - m.css[3] * Math.min(2, m.dpr)) <= 1, 'iPhone: canvas back to the view size', { css: m.css, backing: m.backing });
  ok(m.scroll[0] <= m.inner[0], 'iPhone landscape (normal layout): no horizontal scroll', m.scroll);
  const small = await page.getByRole('button', { name: 'Full screen' }).boundingBox();
  ok(!!small && small.width <= 48 && small.height >= 44, 'iPhone landscape (normal layout): the button is icon-only, still 44 px', small);
  await shot(page, 'iphone14-landscape-studio');

  // portrait again: the hint stays dismissed
  await page.setViewportSize({ width: 390, height: 664 });
  await sleep(300);
  await page.getByRole('button', { name: 'Full screen' }).tap();
  await page.waitForSelector('[data-fullscreen="pseudo"]');
  await sleep(300);
  m = await page.evaluate(measure);
  ok(!m.hint, 'iPhone: dismissed hint does not come back');
  checkFills(m, 'iPhone portrait (again)');
  ok(await page.evaluate(() => /viewport-fit=cover/.test(document.querySelector('meta[name="viewport"]').content)), 'iPhone: the layer reaches under the notch (viewport-fit=cover)');

  // the system back gesture leaves full screen and stays on the song
  const url = page.url();
  await page.goBack();
  await page.waitForSelector('[data-fullscreen="off"]', { timeout: 5000 }).catch(() => {});
  await sleep(300);
  m = await page.evaluate(measure);
  ok(m.mode === 'off' && page.url() === url && m.htmlOverflow === '' && m.navVisible, 'iPhone: back leaves full screen, same song, shell back', { mode: m.mode, url: page.url() });
  ok(await page.evaluate(() => !/viewport-fit/.test(document.querySelector('meta[name="viewport"]').content)), 'iPhone: viewport tag restored');
  await page.getByRole('button', { name: 'Full screen' }).tap();
  await page.waitForSelector('[data-fullscreen="pseudo"]');
  await page.getByRole('button', { name: 'Exit full screen' }).tap();
  await page.waitForSelector('[data-fullscreen="off"]');
  await sleep(300);
  ok(page.url() === url, 'iPhone: Exit removes its back entry (no extra history step)', page.url());
  await page.getByRole('button', { name: 'Full screen' }).tap();
  await page.waitForSelector('[data-fullscreen="pseudo"]');
  await sleep(300);

  // leaving the page while full screen restores the shell
  await page.evaluate(() => {
    history.pushState({}, '', '/library');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForFunction(() => !document.querySelector('[data-fullscreen]'), null, { timeout: 10000 });
  await sleep(300);
  const after = await page.evaluate(() => ({
    nav: [...document.querySelectorAll('nav[aria-label="Main"]')].some((n) => getComputedStyle(n).display !== 'none'),
    html: document.documentElement.style.overflow,
    body: document.body.style.overflow,
    scrollW: document.documentElement.scrollWidth,
    w: innerWidth,
  }));
  ok(after.nav && after.html === '' && after.body === '' && after.scrollW <= after.w, 'iPhone: leaving the Studio in full screen restores the shell and overflow', after);
  await ctx.close();
}

/** is the element's centre hit by a pointer there (nothing on top of it)? */
const hitTest = (sel) => {
  const out = {};
  for (const [name, q] of Object.entries(sel)) {
    const els = [...document.querySelectorAll(q)].filter((e) => e.getBoundingClientRect().width > 0);
    const el = els[0];
    if (!el) {
      out[name] = { count: 0, hit: false };
      continue;
    }
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    out[name] = { count: els.length, hit: !!hit && (el === hit || el.contains(hit)), top: Math.round(b.top), bottom: Math.round(b.bottom) };
  }
  return out;
};
const SHEET_TARGETS = {
  enter: 'button[aria-label="Full screen"]',
  smaller: '[data-testid="sheet-toolbar"] button[aria-label="Smaller"]',
  bigger: '[data-testid="sheet-toolbar"] button[aria-label="Bigger"]',
  follow: '[data-testid="sheet-toolbar"] button[aria-pressed]:not([aria-label])',
  exit: 'button[aria-label="Exit full screen"]',
};

async function sheetView(browser, base, kind) {
  const phone = kind === 'iPhone';
  const ctx = await browser.newContext(phone ? { ...devices['iPhone 14'] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  if (phone) await ctx.addInitScript(NO_FULLSCREEN_API);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => ok(false, `${kind} sheet page error: ${e.message}`));
  await openDemo(page, base);
  await page.getByRole('radio', { name: /Sheet music/ }).click();
  await page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
  await sleep(600);
  let h = await page.evaluate(hitTest, SHEET_TARGETS);
  ok(h.enter.count === 1 && h.enter.hit, `${kind} sheet: one Full screen button, and nothing covers it`, h.enter);
  ok(h.smaller.hit && h.bigger.hit && h.follow.hit, `${kind} sheet: zoom and Follow can be pressed`, { s: h.smaller, b: h.bigger, f: h.follow });
  await shot(page, `${kind}-sheet-button`);

  await page.getByRole('button', { name: 'Full screen' }).click();
  await page.waitForSelector(phone ? '[data-fullscreen="pseudo"]' : '[data-fullscreen="native"]', { timeout: 5000 }).catch(() => {});
  await sleep(600);
  const mode = await page.evaluate(() => document.querySelector('[data-fullscreen]')?.dataset.fullscreen);
  ok(mode === (phone ? 'pseudo' : 'native'), `${kind} sheet: the toolbar's button enters full screen`, { mode });
  h = await page.evaluate(hitTest, SHEET_TARGETS);
  ok(h.exit.hit && h.smaller.hit && h.bigger.hit && h.follow.hit, `${kind} sheet full screen: Exit, zoom and Follow can all be pressed`, h);
  ok(h.smaller.top >= h.exit.bottom, `${kind} sheet full screen: the sheet toolbar sits below the Exit row`, { toolbarTop: h.smaller.top, exitBottom: h.exit.bottom });
  ok(h.enter.count === 0, `${kind} sheet full screen: no Full screen button left`, h.enter);
  const zoom0 = await page.evaluate(() => document.querySelector('[data-testid="sheet-toolbar"] button[title="Reset size"]').textContent);
  await page.locator('[data-testid="sheet-toolbar"] button[aria-label="Bigger"]').click();
  await sleep(300);
  const zoom1 = await page.evaluate(() => document.querySelector('[data-testid="sheet-toolbar"] button[title="Reset size"]').textContent);
  ok(zoom1 !== zoom0 && (await page.evaluate(() => document.querySelector('[data-fullscreen]').dataset.fullscreen)) !== 'off', `${kind} sheet full screen: Bigger works and stays in full screen`, { zoom0, zoom1 });
  await page.locator('[data-testid="sheet-toolbar"] button[title="Reset size"]').click();
  await shot(page, `${kind}-sheet-fullscreen`);

  // the overlay's position bar: ← seeks once; Alt / Cmd + ← is the browser's Back, left alone
  await page.evaluate(() => window.__pv.getPlayer().seek(20));
  await sleep(200);
  await page.locator('[data-fs-controls] [aria-label="Song position"]').focus();
  const t = () => page.evaluate(() => window.__pv.getPlayer().getTime());
  const t0 = await t();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Meta+ArrowLeft');
  await sleep(200);
  const t1 = await t();
  await page.keyboard.press('ArrowLeft');
  await sleep(200);
  const t2 = await t();
  ok(Math.abs(t1 - t0) < 0.01 && Math.abs(t0 - t2 - 5) < 0.3, `${kind} sheet full screen: ← on the position bar seeks 5 s once, Alt/Cmd + ← does not seek`, { t0, t1, t2 });

  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await page.waitForSelector('[data-fullscreen="off"]', { timeout: 5000 }).catch(() => {});
  await sleep(500);
  const after = await page.evaluate(() => ({
    mode: document.querySelector('[data-fullscreen]')?.dataset.fullscreen,
    focus: document.activeElement?.getAttribute('aria-label'),
    music: !!document.querySelector('[data-testid="sheet-music"] .sheet-chunk svg'),
  }));
  ok(after.mode === 'off' && after.music, `${kind} sheet: Exit leaves full screen with the music still drawn`, after);
  ok(after.focus === 'Full screen', `${kind} sheet: focus goes back to the Full screen button`, after);
  await ctx.close();
}

async function desktop(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => ok(false, `desktop page error: ${e.message}`));
  await openDemo(page, base);
  await page.mouse.move(700, 400);

  await page.keyboard.press('f');
  await page.waitForSelector('[data-fullscreen="native"]', { timeout: 5000 }).catch(() => {});
  await sleep(600);
  let m = await page.evaluate(measure);
  ok(m.mode === 'native' && m.fsElementIsStage, 'desktop: F uses the real Fullscreen API on the stage', { mode: m.mode, fs: m.fsElementIsStage });
  ok(m.css[2] === m.inner[0] && m.css[3] === m.inner[1], 'desktop: canvas fills the full-screen window', { css: m.css, inner: m.inner });
  ok(Math.abs(m.backing[0] - m.css[2] * 2) <= 1 && Math.abs(m.backing[1] - m.css[3] * 2) <= 1, 'desktop: backing store at 2×', m.backing);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__pv.getPlayer().isPlaying, null, { timeout: 30000 });
  await sleep(1500);
  await shot(page, 'desktop-fullscreen-controls');
  await waitControls(page, false);
  ok(!(await page.evaluate(measure)).controlsShown, 'desktop: controls hide while playing and the mouse rests');
  ok((await page.evaluate(() => getComputedStyle(document.querySelector('canvas[aria-label="Piano roll"]')).cursor)) === 'none', 'desktop: the mouse pointer hides over the piano roll');
  await shot(page, 'desktop-fullscreen-hidden');
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 320);
  await waitControls(page, true, 2000);
  ok((await page.evaluate(measure)).controlsShown, 'desktop: moving the mouse shows them');

  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.querySelector('[data-fullscreen]').contains(document.activeElement)), 'desktop: Tab stays inside full screen');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-fullscreen="off"]', { timeout: 5000 }).catch(() => {});
  await sleep(500);
  m = await page.evaluate(measure);
  ok(await page.evaluate(() => !document.querySelector('[inert]:not([data-fs-controls])')), 'desktop: nothing left inert after leaving');
  ok(m.mode === 'off' && !m.fsElementIsStage && (await page.evaluate(() => !document.fullscreenElement)), 'desktop: Esc leaves full screen');
  ok(m.navVisible && m.headerVisible && m.transportVisible, 'desktop: layout restored after Esc');

  await page.getByRole('button', { name: 'Full screen' }).click();
  await page.waitForSelector('[data-fullscreen="native"]', { timeout: 5000 }).catch(() => {});
  ok((await page.evaluate(measure)).fsElementIsStage, 'desktop: the button enters real full screen');
  await page.keyboard.press('f');
  await page.waitForSelector('[data-fullscreen="off"]', { timeout: 5000 }).catch(() => {});
  await sleep(300);
  m = await page.evaluate(measure);
  ok(m.mode === 'off' && (await page.evaluate(() => !document.fullscreenElement)), 'desktop: F again leaves full screen');

  // leaving the browser's full screen by other means (its own UI) is noticed
  await page.keyboard.press('f');
  await page.waitForSelector('[data-fullscreen="native"]', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForSelector('[data-fullscreen="off"]', { timeout: 5000 }).catch(() => {});
  ok((await page.evaluate(measure)).mode === 'off', 'desktop: leaving full screen through the browser resets the stage');
  await page.evaluate(() => window.__pv.getPlayer().pause());

  // F does nothing while a dialog is open (the dialog would be hidden behind full screen)
  await page.locator('header').getByRole('button').filter({ has: page.locator('svg.lucide-film') }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('f');
  await sleep(500);
  ok((await page.evaluate(measure)).mode === 'off' && (await page.getByRole('dialog').isVisible()), 'desktop: F with a dialog open stays out of full screen');
  await page.keyboard.press('Escape');
  await ctx.close();
}

/** a tap meant to bring the controls back, on the spot where a hidden control sits, presses nothing */
async function ghostTaps(page, label) {
  const spots = await page.evaluate(() => {
    const box = (sel) => {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      return b ? { x: b.left + b.width / 2, top: b.top, y: b.top + b.height / 2 } : null;
    };
    return {
      exit: box('[data-fs-controls] button[aria-label="Exit full screen"]'),
      pause: box('[data-fs-controls] button[aria-label="Pause"]'),
      speed: box('[data-fs-controls] button[aria-label^="Playback speed"]'),
    };
  });
  for (const [name, spot] of Object.entries(spots)) {
    if (!spot) {
      ok(false, `${label}: ${name} control found`);
      continue;
    }
    await waitControls(page, false);
    const before = await page.evaluate(measure);
    ok((await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [spot.x, spot.y])) === 'CANVAS', `${label}: hidden ${name} takes no taps`);
    await page.touchscreen.tap(spot.x, name === 'pause' ? spot.top + 4 : spot.y);
    await sleep(250);
    const m = await page.evaluate(measure);
    const speedOpen = await page.evaluate(() => !!document.querySelector('[data-fs-controls] [role="group"][aria-label="Playback speed"]'));
    ok(m.controlsShown && m.mode === before.mode && m.playing && !speedOpen, `${label}: a revealing tap on hidden ${name} only shows the controls`, { mode: m.mode, playing: m.playing, speedOpen });
  }
}

async function ipad(browser, base) {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => ok(false, `iPad page error: ${e.message}`));
  await openDemo(page, base);
  await page.getByRole('button', { name: 'Full screen' }).tap();
  await page.waitForSelector('[data-fullscreen="native"]', { timeout: 5000 }).catch(() => {});
  await sleep(500);
  const m = await page.evaluate(measure);
  ok(m.mode === 'native', 'iPad: real Fullscreen API', m.mode);
  ok(!m.hint, 'iPad portrait: no "turn sideways" hint (phones only)');
  await page.getByRole('button', { name: 'Exit full screen' }).tap();
  await ctx.close();
}

/** production build with the netlify.toml headers: manifest, icons, CSP, isolation */
async function production(browser) {
  const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(distPort)], { stdio: ['ignore', 'inherit', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', (d) => (stderr += d));
  try {
    await sleep(800);
    const base = `http://127.0.0.1:${distPort}`;
    const ctx = await browser.newContext({ ...devices['iPhone 14'] });
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/studio`);
    await page.getByRole('button', { name: 'Demo' }).waitFor({ timeout: 30000 });
    const r = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      const res = await fetch(link.href);
      const manifest = await res.json();
      const icons = await Promise.all(
        [...manifest.icons.map((i) => i.src), document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href')].map(async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          return `${src} ${img.naturalWidth}×${img.naturalHeight}`;
        }),
      );
      return {
        type: res.headers.get('content-type'),
        display: manifest.display,
        icons,
        capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        isolated: crossOriginIsolated,
      };
    });
    // the browser's own manifest load (manifest-src, which falls back to default-src)
    const cdp = await ctx.newCDPSession(page);
    const app = await cdp.send('Page.getAppManifest');
    ok(!!app.data && app.errors.length === 0 && JSON.parse(app.data).display === 'standalone', 'build: Chromium loads the manifest itself', { url: app.url, errors: app.errors });
    await sleep(300);
    const csp = await page.evaluate(() => window.__csp);
    ok(r.display === 'standalone' && /manifest\+json|json/.test(r.type ?? ''), 'build: manifest served, display standalone', r);
    ok(r.icons.length === 4 && r.capable === 'yes', 'build: icons and apple-touch-icon load', r.icons);
    ok(csp.length === 0, 'build: no CSP violations (manifest-src falls back to default-src self)', csp);
    ok(r.isolated === true, 'build: /studio still cross-origin isolated');
    ok(!/DUPLICATE/.test(stderr), 'build: no duplicate COOP/COEP headers');
    await ctx.close();
  } finally {
    server.kill();
  }
}

// node_modules may be a symlink outside the repo (fonts are served from there)
const vite = await createServer({
  root,
  server: { port, strictPort: true, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } },
  logLevel: 'error',
});
await vite.listen();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const base = `http://localhost:${port}`;
  await iphone(browser, base);
  await ipad(browser, base);
  await desktop(browser, base);
  await sheetView(browser, base, 'desktop');
  await sheetView(browser, base, 'iPhone');
  if (dist) await production(browser);
} catch (e) {
  ok(false, `crashed: ${e.stack ?? e}`);
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\n${failed ? `${failed} FAILED` : 'all passed'} — screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
