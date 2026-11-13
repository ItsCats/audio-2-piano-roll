/**
 * Deploy safety (netlify.toml redirects + src/lib/newVersion.ts) on a production build served with
 * the netlify.toml rules (tests/e2e/isolation.server.py):
 *  - a page refresh works on every route (the single-page-app rule);
 *  - missing files under /assets, /models, /samples and /pdfjs get a real 404 that is not cached
 *    (no long Cache-Control from the [[headers]] rules), while existing ones keep their cache;
 *  - a tab opened before a deploy: opening a page whose code is gone reloads once, with a note,
 *    and then works; a second failure soon after does not reload again but shows "Reload";
 *  - a recording that fails to import because its code is gone is never thrown away by an automatic
 *    reload: the note offers "Reload" and "Download recording" still works.
 *
 *   npx vite build --outDir /tmp/p2v-v1
 *   npx vite build --outDir /tmp/p2v-v2 --config tests/e2e/deploy-safe.v2.config.ts   (same app, all file names changed)
 *   node tests/e2e/deploy-safe.mjs --v1 /tmp/p2v-v1 --v2 /tmp/p2v-v2 [--port 5397]
 *
 * Prints one PASS/FAIL line per check; exits 1 on a failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
const v1 = path.resolve(opt('v1', ''));
const v2 = path.resolve(opt('v2', ''));
const port = Number(opt('port', '5397'));
if (!fs.existsSync(path.join(v1, 'index.html')) || !fs.existsSync(path.join(v2, 'index.html'))) {
  console.error('usage: node tests/e2e/deploy-safe.mjs --v1 <build> --v2 <build with other file names>');
  process.exit(2);
}

// the server's root is a symlink: switching it is the "deploy"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-deploy-'));
const live = path.join(tmp, 'live');
const deploy = (dir) => {
  const next = path.join(tmp, 'next');
  fs.rmSync(next, { force: true });
  fs.symlinkSync(dir, next);
  fs.renameSync(next, live);
};
deploy(v1);

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), live, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  // ---- refresh on every route
  const routes = ['/', '/import', '/import/youtube', '/import?tab=youtube', '/studio', '/studio/some-song-id', '/library', '/settings', '/accuracy', '/credits', '/privacy', '/terms', '/copyright', '/no-such-page'];
  for (const r of routes) {
    const res = await fetch(base + r);
    const html = await res.text();
    check(`refresh ${r}`, res.status === 200 && html.includes('<div id="root">'), `status ${res.status}`);
  }

  // ---- missing static files: real, uncached 404
  for (const p of ['/assets/Studio-doesnotexist.js', '/assets/x.css', '/models/nope.onnx', '/models/scnet/nope.onnx?v=1234', '/samples/nope.ogg', '/pdfjs/nope.wasm']) {
    const res = await fetch(base + p);
    const cc = res.headers.get('cache-control') ?? '';
    const body = await res.text();
    check(`404 ${p}`, res.status === 404 && !/immutable|max-age=[1-9]/.test(cc) && !body.includes('<div id="root">'), `status ${res.status}, cache-control "${cc}"`);
  }
  // existing files keep their long cache
  const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(fs.readFileSync(path.join(v1, 'index.html'), 'utf8'))[1];
  {
    const res = await fetch(base + entry);
    check(`existing ${entry} cached`, res.status === 200 && /immutable/.test(res.headers.get('cache-control') ?? ''), `status ${res.status}`);
    const sample = fs.readdirSync(path.join(v1, 'samples'), { recursive: true }).find((f) => /\.(ogg|mp3|m4a|json)$/.test(String(f)));
    if (sample) {
      const s = await fetch(`${base}/samples/${sample}`);
      check(`existing /samples/${sample}`, s.status === 200);
    }
  }

  // ---- a tab from before a deploy
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const v1Entry = await page.evaluate(() => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src'));
    let loads = 0;
    page.on('load', () => loads++);
    const note = page.getByText('A new version is available — reloading');
    deploy(v2);
    // open My Library: its code is gone in the new version
    await page.evaluate(() => {
      history.pushState({}, '', '/library');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    const sawNote = await note.waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('stale tab: says a new version is available', sawNote);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src')?.includes('-v2-'), null, { timeout: 10000 }).catch(() => {});
    const v2Entry = await page.evaluate(() => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src'));
    check('stale tab: reloaded once into the new version', loads === 1 && v2Entry !== v1Entry && /-v2-/.test(v2Entry ?? ''), `loads ${loads}, ${v1Entry} → ${v2Entry}`);
    const libraryShown = await page.getByRole('heading', { name: /library/i }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('stale tab: My Library opens after the reload', libraryShown && new URL(page.url()).pathname === '/library', page.url());

    // a second "deploy" right after: no reload loop, the error screen offers Reload
    deploy(v1);
    loads = 0;
    await page.evaluate(() => {
      history.pushState({}, '', '/settings');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    const reloadBtn = page.getByRole('button', { name: 'Reload', exact: true });
    const shown = await reloadBtn.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await page.waitForTimeout(1500);
    check('second failure soon after: no automatic reload, the error screen offers Reload', shown && loads === 0, `loads ${loads}`);
    check('error screen explains it plainly', await page.getByText('This page could not be loaded').isVisible());
    await reloadBtn.click();
    await page.waitForLoadState('networkidle');
    const settingsShown = await page.getByRole('heading', { name: /settings/i }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('Reload opens the page in the current version', settingsShown, page.url());

    // offline / same version: a failed chunk does not reload
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto(`${base}/`, { waitUntil: 'networkidle' });
    await p2.route('**/assets/Library-*.js', (r) => r.abort());
    let loads2 = 0;
    p2.on('load', () => loads2++);
    await p2.evaluate(() => {
      history.pushState({}, '', '/library');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await p2.getByRole('button', { name: 'Reload', exact: true }).waitFor({ timeout: 10000 }).catch(() => {});
    await p2.waitForTimeout(1500);
    check('network failure without a new version: no reload', loads2 === 0, `loads ${loads2}`);

    // a recording whose import fails because the new version removed its code: no automatic
    // reload (it would throw the recording away); the note offers Reload, the recording can be saved
    deploy(v1);
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    await ctx3.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.getContext('2d').fillRect(0, 0, 8, 8);
        const ac = new AudioContext();
        const dest = ac.createMediaStreamDestination();
        const o = ac.createOscillator();
        o.frequency.value = 440;
        o.connect(dest);
        o.start();
        return new MediaStream([...c.captureStream(5).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      };
    });
    const p3 = await ctx3.newPage();
    await p3.goto(`${base}/import?tab=computer`, { waitUntil: 'networkidle' });
    await p3.getByRole('checkbox', { name: /I own this music/ }).check();
    await p3.getByRole('button', { name: 'Start recording' }).click();
    await p3.waitForTimeout(3000);
    let loads3 = 0;
    p3.on('load', () => loads3++);
    deploy(v2);
    // the old version's transcription worker is gone (the second build here keeps the worker's file
    // name, as its code is the same; a deploy that changes the worker removes the old file)
    await p3.route('**/assets/*.worker-*.js', (r) => r.fulfill({ status: 404, body: 'Not found' }));
    await p3.getByRole('button', { name: 'Stop & transcribe' }).click();
    const held = p3.getByText('A new version is available. Download your recording first, then reload.');
    const heldShown = await held.waitFor({ timeout: 30000 }).then(() => true, () => false);
    await p3.waitForTimeout(2500);
    check('recording import fails after a deploy: no automatic reload, the note asks to save the recording first', heldShown && loads3 === 0, `note ${heldShown}, loads ${loads3}`);
    const dl = p3.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await p3.getByRole('button', { name: 'Download recording' }).click().catch(() => undefined);
    const file = await dl;
    check('…and "Download recording" still saves it', !!file && /\.(webm|m4a|mp4|ogg)$/.test(file.suggestedFilename()), file?.suggestedFilename() ?? 'no download');
    await p3.locator('#pv-update-note').getByRole('button', { name: 'Reload' }).click();
    await p3.waitForLoadState('networkidle');
    const v2Now = await p3.evaluate(() => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src'));
    check('…then "Reload" in the note opens the new version', /-v2-/.test(v2Now ?? ''), v2Now ?? '');
    await ctx3.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
