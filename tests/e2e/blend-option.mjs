/**
 * The "Add the high-accuracy piano model" option ("Full song + piano model") as a user meets it on the
 * Import page, in Playwright Chromium on a PRODUCTION build served with the exact netlify.toml headers
 * (tests/e2e/isolation.server.py). No import runs here (tests/e2e/blend.mjs runs the pipeline).
 *
 *   npm run build
 *   node tests/e2e/blend-option.mjs --dist dist [--port 5399] [--shots DIR]
 *
 * Desktop (1440x900, 16 GB reported): with "Full song" the option is shown, can be ticked, is off by
 * default (importStore PIANO_BLEND_DEFAULT) and the choice is remembered across a reload (import prefs
 * `pianoBlend`); unticking "Separate vocals & drums" disables it ("Needs in-browser instrument
 * separation."); "Piano solo" shows the solo "High-accuracy piano model" option instead.
 * iPhone 14 (memory-constrained): the option is shown unticked and disabled with "Not recommended on this
 * device: it needs about 0.8 GB more memory and may close the tab.", also when the prefs say it was ticked.
 * Both: no console errors, no sideways scroll.
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
const dist = path.resolve(opt('dist', path.join(root, 'dist')));
const port = Number(opt('port', '5399'));
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-blend-option-')));
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/blend-option.mjs --dist BUILD_DIR [--port N] [--shots DIR]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const { chromium, devices } = await import('playwright');
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
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
const check = (ok, label, detail = '') => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
};
const LABEL = /Add the high-accuracy piano model/;
const MEMORY = 'Not recommended on this device: it needs about 0.8 GB more memory and may close the tab.';
const NEEDS_SEP = 'Needs in-browser instrument separation.';

async function open(contextOpts, initPrefs) {
  const ctx = await browser.newContext(contextOpts);
  if (initPrefs) await ctx.addInitScript((p) => localStorage.setItem('piano2vision-import-prefs', p), JSON.stringify(initPrefs));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base + '/import');
  await page.waitForLoadState('load');
  await page.getByRole('radiogroup', { name: 'Detection preset' }).waitFor();
  return { ctx, page, errors };
}
const preset = (page, name) => page.getByRole('radiogroup', { name: 'Detection preset' }).getByRole('radio', { name }).click();
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

try {
  // ---- desktop
  {
    const { ctx, page, errors } = await open({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 16 }));
    await page.reload();
    await preset(page, 'Full song');
    const box = page.getByRole('checkbox', { name: LABEL });
    await box.waitFor();
    const sep = page.getByRole('checkbox', { name: /Separate vocals/ });
    check(await sep.isChecked(), 'desktop    ', 'separation on by default for Full song');
    check((await box.isEnabled()) && !(await box.isChecked()), 'desktop    ', 'option shown, enabled, off by default');
    const hint = await page.locator('#piano-blend-hint').innerText();
    check(/keeping the Full song melody line and bass/.test(hint) && /41 MB the first time/.test(hint), 'desktop    ', 'description');
    await box.click();
    check(await box.isChecked(), 'desktop    ', 'ticked');
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('piano2vision-import-prefs') ?? '{}'));
    check(prefs.pianoBlend === true, 'desktop    ', `remembered in the import prefs ${JSON.stringify(prefs)}`);
    await page.screenshot({ path: path.join(shots, 'blend-option-desktop.png') });
    await page.reload();
    await preset(page, 'Full song');
    check(await page.getByRole('checkbox', { name: LABEL }).isChecked(), 'desktop    ', 'still ticked after a reload');
    await page.getByRole('checkbox', { name: /Separate vocals/ }).click();
    const box2 = page.getByRole('checkbox', { name: LABEL });
    check(!(await box2.isEnabled()) && !(await box2.isChecked()) && (await page.locator('#piano-blend-hint').innerText()).includes(NEEDS_SEP), 'desktop    ', 'separation off: disabled, "Needs in-browser instrument separation."');
    await page.getByRole('checkbox', { name: /Separate vocals/ }).click();
    await preset(page, 'Piano solo');
    check((await page.getByRole('checkbox', { name: LABEL }).count()) === 0 && (await page.getByRole('checkbox', { name: /^High-accuracy piano model/ }).count()) === 1, 'desktop    ', 'Piano solo: the solo option instead');
    check((await sideScroll(page)) <= 0, 'desktop    ', 'no sideways scroll');
    check(!errors.length, 'desktop    ', errors.length ? `console errors: ${errors.slice(0, 3).join(' | ')}` : 'no console errors');
    await ctx.close();
  }
  // ---- iPhone (memory-constrained), with the choice remembered as ticked
  {
    const { ctx, page, errors } = await open({ ...devices['iPhone 14'], deviceScaleFactor: 2 }, { separate: {}, pianoBlend: true });
    await preset(page, 'Full song');
    const box = page.getByRole('checkbox', { name: LABEL });
    await box.waitFor();
    await box.scrollIntoViewIfNeeded();
    const hint = await page.locator('#piano-blend-hint').innerText();
    check(!(await box.isEnabled()) && !(await box.isChecked()), 'iPhone     ', 'shown unticked and disabled (prefs said ticked)');
    check(hint.includes(MEMORY), 'iPhone     ', `reason: ${hint.split('\n').pop()}`);
    await page.screenshot({ path: path.join(shots, 'blend-option-phone.png') });
    check((await sideScroll(page)) <= 0, 'iPhone     ', 'no sideways scroll');
    check(!errors.length, 'iPhone     ', errors.length ? `console errors: ${errors.slice(0, 3).join(' | ')}` : 'no console errors');
    await ctx.close();
  }
} catch (err) {
  failed = true;
  console.error('FAIL', err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(`screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
