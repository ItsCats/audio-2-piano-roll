/**
 * Title page UI in the Export video dialog, against a production build served with the
 * netlify.toml headers (CSP included) by tests/e2e/isolation.server.py.
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/title-card-ui.mjs --dist /tmp/p2v-dist --out DIR [--image photo.png] [--export] [--port 5386]
 *
 * Desktop (1440×900) and phone (390×844, touch) runs, both at deviceScaleFactor 2: opens the demo,
 * turns on the title page, types the title fields, tries every style, a pattern fill, an uploaded
 * image fill and the end card, and checks: no console errors (CSP), the fonts load, the preview
 * changes when typing, and on the phone nothing is wider than the screen. With --export it renders
 * a short 1080p clip (custom 8 s range) in 16:9 and 9:16 and saves the files and frames (ffmpeg) to DIR.
 * Screenshots go to DIR (never into the repo).
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);
const dist = opt('dist');
const out = opt('out');
const image = opt('image');
const port = Number(opt('port', '5386'));
if (!dist || !out) {
  console.error('usage: node tests/e2e/title-card-ui.mjs --dist DIR --out DIR [--image file] [--export]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((r) => setTimeout(r, 1200));
const base = `http://localhost:${port}`;
const { chromium } = await import('playwright');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
};

const TEXT = { Title: 'Light on Snow', Subtitle: 'Suite Winterlight', 'Composer or artist': 'A. Vane', Credit: 'Piano2Vision', 'Small line': 'For you' };

async function openDialog(page, phone) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.getByText('Try the demo').first().click();
  await page.waitForURL(/studio/);
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);
  await page.locator('button:has(svg.lucide-film)').first().click();
  await page.getByRole('dialog', { name: 'Export video' }).waitFor();
  return errors;
}

const dialog = (page) => page.getByRole('dialog', { name: 'Export video' });
const titleSection = (page) => dialog(page).locator('div.border-t', { hasText: 'Add a title page' }).first();
const previewPixels = (page, label) => page.getByRole('img', { name: label }).evaluate((c) => c.toDataURL());

async function setRange(locator, value) {
  await locator.evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function fillTitle(page) {
  const sec = titleSection(page);
  for (const [label, v] of Object.entries(TEXT)) await sec.getByLabel(label, { exact: true }).fill(v);
}

async function shot(page, locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(450); // fonts + one animation frame
  await locator.screenshot({ path: path.join(out, name) });
}

try {
  // ---------------- desktop ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = await openDialog(page, false);
    await page.getByRole('switch', { name: 'Add a title page' }).click();
    const before = await previewPixels(page, 'Title page preview');
    await fillTitle(page);
    await page.waitForTimeout(600);
    const after = await previewPixels(page, 'Title page preview');
    check('desktop: typing changes the preview', before !== after);
    const fontsOk = await page.evaluate(() => [...document.fonts].filter((f) => f.family.includes('P2V')).map((f) => `${f.family} ${f.weight} ${f.status}`));
    check('desktop: title fonts load from the build (CSP font-src)', fontsOk.some((f) => f.endsWith('loaded')) && !fontsOk.some((f) => f.endsWith('error')), fontsOk.filter((f) => !f.endsWith('unloaded')).join(', '));
    await page.screenshot({ path: path.join(out, 'dialog-desktop.png') });
    const sec = titleSection(page);
    for (const name of ['Classic', 'Gold', 'Floral', 'Romance', 'Modern', 'Gala']) {
      await sec.getByRole('button', { name: `${name} style` }).click();
      await shot(page, sec.getByRole('img', { name: 'Title page preview' }), `preview-${name.toLowerCase()}.png`);
    }
    await sec.getByLabel('Small line', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'dialog-desktop-fields.png') });
    // pattern fill
    await sec.getByRole('button', { name: 'Classic style' }).click();
    await sec.getByRole('button', { name: 'Customize' }).click();
    await sec.getByRole('radio', { name: 'Pattern' }).click();
    await sec.getByRole('button', { name: 'Marble pattern' }).click();
    await sec.getByLabel('Use on').selectOption('all');
    await shot(page, sec.getByRole('img', { name: 'Title page preview' }), 'preview-classic-marble.png');
    await sec.getByLabel('Divider').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'dialog-desktop-customize.png') });
    // image fill (a picture made for the test)
    if (image) {
      await sec.getByRole('button', { name: 'Floral style' }).click();
      await sec.getByRole('radio', { name: 'My image' }).click();
      await sec.locator('input[type=file]').setInputFiles(image);
      await page.waitForTimeout(1200);
      await shot(page, sec.getByRole('img', { name: 'Title page preview' }), 'preview-floral-image-fill.png');
      const stored = await page.evaluate(
        () =>
          new Promise((res) => {
            const r = indexedDB.open('pianovision');
            r.onsuccess = () => {
              const tx = r.result.transaction('media', 'readonly').objectStore('media').getAll();
              tx.onsuccess = () => res(tx.result.map((m) => ({ purpose: m.purpose, type: m.type, size: m.blob.size })));
            };
          }),
      );
      const bmp = await page.evaluate(async () => {
        const r = await new Promise((res) => {
          const o = indexedDB.open('pianovision');
          o.onsuccess = () => {
            const q = o.result.transaction('media', 'readonly').objectStore('media').getAll();
            q.onsuccess = () => res(q.result.find((m) => m.purpose === 'title'));
          };
        });
        const b = await createImageBitmap(r.blob);
        return [b.width, b.height];
      });
      check('image fill: the upload is stored locally and downscaled', stored.some((m) => m.purpose === 'title') && Math.max(...bmp) <= 1600, `${JSON.stringify(stored)} ${bmp.join('×')}`);
      await sec.getByRole('button', { name: 'Floral style' }).click();
    } else await sec.getByRole('button', { name: 'Floral style' }).click();
    // end card
    await page.getByRole('switch', { name: 'Add an end card' }).click();
    const endSec = dialog(page).locator('div.border-t', { hasText: 'Add an end card' }).first();
    await endSec.getByLabel('Small line', { exact: true }).fill('See you next time');
    await endSec.getByLabel('Small line', { exact: true }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, 'dialog-desktop-end-card.png') });
    // shown length includes the cards
    const lenText = await dialog(page).locator('p.font-mono').first().textContent();
    console.log(`  shown: ${lenText}`);
    check('no console errors (desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));

    if (flag('export')) {
      await dialog(page).getByRole('radio', { name: 'Custom', exact: true }).click();
      await setRange(dialog(page).getByLabel('Start', { exact: true }), 10);
      await setRange(dialog(page).getByLabel('End', { exact: true }), 18);
      await dialog(page).getByLabel('Frame rate').selectOption('30');
      await dialog(page).getByLabel('Resolution').selectOption('1080');
      for (const [orient, label] of [
        ['169', '16:9'],
        ['916', '9:16'],
      ]) {
        await dialog(page).getByRole('radio', { name: label, exact: true }).click();
        await page.waitForTimeout(300);
        const t0 = Date.now();
        await page.getByRole('button', { name: 'Render video' }).click();
        await page.getByRole('button', { name: /Download MP4/ }).waitFor({ timeout: 600000 });
        const secs = (Date.now() - t0) / 1000;
        // the app's own Download button (fetching the blob: URL from the page is blocked by the CSP)
        const file = path.join(out, `export-${orient}.mp4`);
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download MP4/ }).click()]);
        await download.saveAs(file);
        const info = await dialog(page).locator('span', { hasText: /MB ·/ }).first().textContent();
        console.log(`  export ${label}: ${info} in ${secs.toFixed(0)} s`);
        await page.screenshot({ path: path.join(out, `dialog-done-${orient}.png`) });
        const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
        // title 0..4 s (crossfade 3.2..4), roll, end card the last 4 s
        for (const [tag, t] of [
          ['title', 2.6],
          ['fade', 3.6],
          ['roll', 6.5],
          ['end', dur - 2],
        ])
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', path.join(out, `frame-${orient}-${tag}.png`)]);
        check(`export ${label}: length includes title + end card`, dur > 8 + 8, `${dur.toFixed(2)} s`);
        await page.getByRole('button', { name: 'Back to settings' }).click();
      }
    }
    await ctx.close();
  }

  // ---------------- phone ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = await openDialog(page, true);
    const sw = page.getByRole('switch', { name: 'Add a title page' });
    await sw.scrollIntoViewIfNeeded();
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.tap();
    const before = await previewPixels(page, 'Title page preview');
    await titleSection(page).getByLabel('Title', { exact: true }).fill('Nocturne');
    await page.waitForTimeout(600);
    const after = await previewPixels(page, 'Title page preview');
    check('phone: typing changes the preview', before !== after);
    await titleSection(page).getByLabel('Title', { exact: true }).fill('Light on Snow');
    const customize = titleSection(page).getByRole('button', { name: 'Customize' });
    if ((await customize.getAttribute('aria-expanded')) !== 'true') await customize.tap();
    const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    check('phone: no horizontal scrolling', overflow.doc <= 390 && overflow.body <= 390, JSON.stringify(overflow));
    const outside = await dialog(page).evaluate((d) => {
      const bad = [];
      for (const el of d.querySelectorAll('button, input, select, canvas, label')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        if (r.left < -0.5 || r.right > window.innerWidth + 0.5) bad.push(`${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20)} ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
      return bad;
    });
    check('phone: every control is inside the screen width', outside.length === 0, outside.slice(0, 5).join(' | '));
    await page.screenshot({ path: path.join(out, 'phone-dialog-top.png') });
    const sec = titleSection(page);
    await shot(page, sec.getByRole('img', { name: 'Title page preview' }), 'phone-preview.png');
    // full-height screenshots of the section while scrolling through it
    const box = await sec.boundingBox();
    let i = 0;
    for (const target of [sec.getByRole('img', { name: 'Title page preview' }), sec.getByRole('group', { name: 'Style' }), sec.getByLabel('Small line', { exact: true }), sec.getByLabel('Font'), sec.getByRole('switch', { name: 'Shine' })]) {
      await target.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(out, `phone-dialog-${++i}.png`) });
    }
    void box;
    // typing in a lower field: the (pinned) title preview stays on screen
    for (const label of ['Composer or artist', 'Small line']) {
      const field = sec.getByLabel(label, { exact: true });
      await field.scrollIntoViewIfNeeded();
      await field.focus();
      await page.waitForTimeout(250);
      const seen = await sec.getByRole('img', { name: 'Title page preview' }).evaluate((c) => {
        const r = c.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight, visible: hit === c };
      });
      check(`phone: the preview stays in view while typing in ${label}`, seen.visible && seen.top >= 0 && seen.bottom <= seen.h, JSON.stringify(seen));
    }
    await page.screenshot({ path: path.join(out, 'phone-dialog-typing.png') });
    check('no console errors (phone)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} failures` : 'all passed');
process.exit(failures ? 1 : 0);
