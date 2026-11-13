/**
 * Sheet-music import in Playwright Chromium, on a production build served with the exact
 * netlify.toml headers (tests/e2e/isolation.server.py: CSP without 'unsafe-eval', COOP/COEP).
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/sheet-import.mjs --dist /tmp/p2v-dist --score a.musicxml --score b.mxl [--port 5395] [--shots DIR]
 *
 * For each score file, on desktop and at iPhone 14 size: import it from the "MIDI / Sheet music"
 * tab, land in the Studio with the "Sheet music" badge, play for a moment (the position moves),
 * show the piano roll on Hard and Easy, open the Sheet music view and switch Easy / Medium / Hard
 * (the music is drawn each time), with the open import tab fully in view, and with
 * no CSP violations, console errors or sideways page scroll. Score files (use public-domain music)
 * and screenshots stay outside the repo (`--shots`, default: the OS temp folder).
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
const scores = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--score') scores.push(path.resolve(args[i + 1]));
const dist = opt('dist');
const port = Number(opt('port', '5395'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-sheet-import-')));
if (!dist || !fs.existsSync(path.join(dist, 'index.html')) || !scores.length) {
  console.error('usage: node tests/e2e/sheet-import.mjs --dist BUILD_DIR --score FILE [--score FILE …] [--port N] [--shots DIR]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const { chromium, devices } = await import('playwright');

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

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  iphone: { ...devices['iPhone 14'], deviceScaleFactor: 2 },
};

async function newPage(contextOpts) {
  const ctx = await browser.newContext(contextOpts);
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
const sheetReady = (page) => page.waitForSelector('[data-testid="sheet-music"] .sheet-chunk svg', { timeout: 60000 });
const position = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('[aria-label^="Song position"]')].find((e) => e.getBoundingClientRect().width > 0);
    return el ? Number(el.getAttribute('aria-valuenow')) : null;
  });

try {
  for (const [dev, opts] of Object.entries(DEVICES)) {
    const { page, errors, ctx } = await newPage(opts);
    await page.goto(base + '/import?tab=midi');
    await page.getByText('Drop a MIDI or sheet-music file').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `${dev}-import-tab.png`) });
    check(`${dev}: import tab has no sideways scroll`, (await sideScroll(page)) <= 0);
    const tabBox = await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]')?.getBoundingClientRect();
      const tab = document.querySelector('[role="tab"][aria-selected="true"]')?.getBoundingClientRect();
      return list && tab ? { left: tab.left - list.left, right: list.right - tab.right } : null;
    });
    check(`${dev}: the open "MIDI / Sheet music" tab is fully in view`, !!tabBox && tabBox.left >= -1 && tabBox.right >= -1, tabBox);
    for (const file of scores) {
      const name = path.basename(file);
      const tag = `${dev}-${name.replace(/[^a-z0-9]+/gi, '-')}`;
      await page.goto(base + '/import?tab=midi');
      await page.locator('input[type="file"]').first().setInputFiles(file);
      await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
      await page.waitForTimeout(1500);
      const badge = await page.getByText('Sheet music', { exact: true }).first().isVisible().catch(() => false);
      check(`${dev} ${name}: opens in the Studio as sheet music`, badge);
      await page.screenshot({ path: path.join(shots, `${tag}-roll.png`) });
      const p0 = await position(page);
      await page.getByRole('button', { name: /^Play/ }).first().click();
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(shots, `${tag}-playing.png`) });
      const p1 = await position(page);
      await page.getByRole('button', { name: /^Pause/ }).first().click();
      check(`${dev} ${name}: playback moves`, p0 !== null && p1 !== null && p1 > p0, { p0, p1 });
      for (const level of ['hard', 'easy']) {
        await page.getByRole('radio', { name: new RegExp(level, 'i') }).first().click();
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(shots, `${tag}-roll-${level}.png`) });
      }
      await page.getByRole('radio', { name: /Sheet music/ }).click();
      await sheetReady(page);
      for (const level of ['easy', 'medium', 'hard']) {
        await page.getByRole('radio', { name: new RegExp(level, 'i') }).click();
        await page.waitForTimeout(1200);
        await sheetReady(page);
        const n = await page.locator('.sheet-chunk svg').count();
        check(`${dev} ${name}: ${level} sheet music drawn`, n > 0, { chunks: n });
        await page.screenshot({ path: path.join(shots, `${tag}-sheet-${level}.png`) });
      }
      check(`${dev} ${name}: no sideways scroll`, (await sideScroll(page)) <= 0);
      await page.getByRole('radio', { name: /Piano roll/ }).click();
    }
    await page.goto(base + '/library');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(shots, `${dev}-library.png`) });
    await page.getByRole('radio', { name: 'Sheet music' }).click();
    await page.waitForTimeout(400);
    const cards = await page.locator('a[href^="/studio/"]').count();
    await page.screenshot({ path: path.join(shots, `${dev}-library-sheet-filter.png`) });
    check(`${dev}: the library's "Sheet music" filter lists the imports`, cards >= scores.length, { cards });
    const csp = await page.evaluate(() => window.__csp);
    check(`${dev}: no CSP violations or console errors`, csp.length === 0 && errors.length === 0, { csp, errors: errors.slice(0, 5) });
    await ctx.close();
  }
} catch (e) {
  check('run', false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify({ shots, results: results.length, failed }, null, 0));
process.exit(failed ? 1 : 0);
