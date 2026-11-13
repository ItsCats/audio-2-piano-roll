/**
 * Cross-origin isolation checks (src/lib/isolation.ts, netlify.toml) in Playwright Chromium.
 *
 *   # production build served with the exact netlify.toml headers (tests/e2e/isolation.server.py)
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/isolation.mjs app --dist /tmp/p2v-dist --audio excerpt.mp3 --image bg.png [--port 5391] [--skip-import]
 *
 *   # separation speed and peak RSS, not isolated (1 thread) vs isolated (the worker's own
 *   # min(4, cores - 1) rule), dev server
 *   node tests/e2e/isolation.mjs bench --audio excerpt.mp3 [--runs single,isolated] [--port 5392]
 *
 * `app` checks: crossOriginIsolated on every app route (also /privacy, /terms, /copyright) and NOT
 * on an unknown path; one full page load when moving on from an unknown path (and none between app
 * routes); old links to the removed YouTube tab (/import/youtube, /import?tab=youtube) land on the
 * isolated "Computer sound" tab; back/forward; no console errors on any page; demo playback; an
 * audio import with "Separate vocals & drums" (timed, peak RSS); a short video export; a background
 * image upload; Back across a document boundary during an import asks first (beforeunload) instead
 * of silently ending it. Audio and images are passed by path (never copied into the
 * repo; songs may be copyrighted). Prints one PASS/FAIL line per check and a JSON summary.
 *
 * `bench` reports the thread count the worker really used (Chromium's hardware-concurrency
 * override does not reach dedicated workers, so other counts can't be forced from here).
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, ...rest] = process.argv.slice(2);
const args = [...rest];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

/** RSS (MB) of the processes started by this node process, except `skip` pids (e.g. the server) */
function rssMB(skip = new Set()) {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let sum = 0;
    const st = [...(kids.get(process.pid) ?? [])].filter((p) => !skip.has(p));
    while (st.length) {
      const p = st.pop();
      sum += rss.get(p) ?? 0;
      st.push(...(kids.get(p) ?? []));
    }
    return sum / 1024;
  } catch {
    return 0;
  }
}

function peakSampler(skip) {
  let peak = rssMB(skip);
  const base = peak;
  const t = setInterval(() => (peak = Math.max(peak, rssMB(skip))), 250);
  return { base, stop: () => (clearInterval(t), Math.round(peak)) };
}

const launch = async () => {
  const { chromium } = await import('playwright');
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
};

let failures = 0;
const results = [];
function check(name, ok, info = '') {
  if (!ok) failures++;
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` — ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}

async function appMode() {
  const dist = opt('dist', null);
  const audio = opt('audio', null);
  const image = opt('image', null);
  const port = +opt('port', '5391');
  const skipImport = flag('skip-import');
  const onlyImport = flag('only-import');
  const verbose = flag('verbose');
  if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) throw new Error('--dist DIR (a vite build) is required');
  const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => (serverErr += d));
  const skip = new Set([server.pid]);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + '/');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const browser = await launch();
  const summary = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    let errors = [];
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 300)}`));
    page.on('crash', () => errors.push('[crash]'));
    const takeErrors = () => {
      const e = errors;
      errors = [];
      return e;
    };
    const coi = () => page.evaluate(() => self.crossOriginIsolated);
    const mark = () => page.evaluate(() => (window.__sameDoc = true));
    const sameDoc = () => page.evaluate(() => window.__sameDoc === true);
    const settle = async () => {
      await page.waitForLoadState('load');
      await page.waitForFunction(() => !!document.querySelector('main')?.firstElementChild && !document.querySelector('main .animate-spin'), null, { timeout: 30000 });
      await page.waitForTimeout(400);
    };

    // settings for the later steps: Full song preset (separation on by default), a 3 s 720p30 export
    await page.goto(base + '/settings');
    await page.evaluate(() => {
      localStorage.setItem(
        'pianovision-settings',
        JSON.stringify({ state: { detectionPreset: 'mix', exportSettings: { range: 'custom', customStart: 0, customEnd: 3, resolution: 720, fps: 30, leadIn: 0, fadeIn: 0, fadeOut: 0.5 } }, version: 1 }),
      );
    });

    page.on('worker', (w) => verbose && console.error(`[worker] ${w.url().slice(-60)}`));
    // 1. every route: isolation state and a clean render
    const routes = ['/', '/import', '/import?tab=computer', '/studio', '/library', '/settings', '/accuracy', '/credits', '/privacy', '/terms', '/copyright', '/studio/does-not-exist', '/no-such-page'];
    for (const r of onlyImport ? [] : routes) {
      await page.goto(base + r);
      await settle();
      const isolated = await coi();
      const want = r !== '/no-such-page';
      const errs = takeErrors();
      check(`route ${r}: crossOriginIsolated=${isolated}`, isolated === want && errs.length === 0, errs.join(' | '));
    }
    summary.headers = {};
    for (const r of ['/', '/privacy', '/studio/x', '/no-such-page', '/assets/none.js']) {
      const h = (await fetch(base + r)).headers;
      summary.headers[r] = { coop: h.get('cross-origin-opener-policy'), coep: h.get('cross-origin-embedder-policy'), csp: h.get('content-security-policy'), xfo: h.get('x-frame-options'), cache: h.get('cache-control') };
    }
    {
      const res = await fetch(base + '/import/youtube', { redirect: 'manual' });
      check('/import/youtube redirects (301) to /import?tab=computer', res.status === 301 && res.headers.get('location') === '/import?tab=computer', { status: res.status, location: res.headers.get('location') });
      check('the security policy allows no YouTube (or other) frames and scripts', /frame-src 'none'/.test(summary.headers['/'].csp ?? '') && !/youtube|ytimg/.test(summary.headers['/'].csp ?? ''), summary.headers['/'].csp);
    }
    check('no duplicate header rules in netlify.toml for any tested path', !/DUPLICATE/.test(serverErr), serverErr.trim());

    if (!onlyImport) {
    // 2. tabs of the Import page, old YouTube links, and leaving an unknown path
    await page.goto(base + '/import');
    await settle();
    await mark();
    const shotDir = opt('shots', null);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'import-audio.png') });
    await page.getByRole('tab', { name: 'Computer sound' }).click();
    await page.waitForURL(/\/import\?tab=computer$/);
    await settle();
    check('Import → Computer sound tab: no page load, isolated', (await sameDoc()) && (await coi()));
    const csUi = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('[role=tab]')].map((t) => `${t.textContent?.trim()}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`),
      start: [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Start recording')),
      rights: !!document.querySelector('label input[type=checkbox]'),
      heading: document.querySelector('h1')?.textContent,
      iframe: !!document.querySelector('iframe'),
    }));
    check('Computer sound tab UI renders (tabs, rights box, Start recording, no player)', csUi.start && csUi.rights && !csUi.iframe && csUi.tabs.length === 4 && csUi.tabs[1] === 'Computer sound*' && csUi.heading === 'Import music', csUi);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'import-computer.png') });
    for (const old of ['/import/youtube', '/import/youtube?url=x', '/import?tab=youtube']) {
      await page.goto(base + old);
      await page.waitForURL(/\/import\?tab=computer/);
      await settle();
      check(`old link ${old} lands on the Computer sound tab, isolated`, (await coi()) && (await page.getByRole('tab', { name: 'Computer sound' }).getAttribute('aria-selected')) === 'true', page.url());
    }
    await page.goto(base + '/no-such-page');
    await settle();
    check('unknown path: not isolated', !(await coi()));
    await mark();
    await page.getByRole('link', { name: 'My Library' }).first().click();
    await page.waitForURL(/\/library$/);
    await settle();
    check('unknown path → Library is one full page load, isolated', !(await sameDoc()) && (await coi()));
    await page.goBack();
    await page.waitForURL(/\/no-such-page$/);
    await settle();
    check('Back to the unknown path: not isolated', !(await coi()));
    await page.goForward();
    await page.waitForURL(/\/library$/);
    await settle();
    check('Forward to Library: isolated', await coi());
    await mark();
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.waitForURL(/\/settings/);
    await settle();
    await page.getByRole('link', { name: 'Privacy', exact: true }).first().click();
    await page.waitForURL(/\/privacy$/);
    await settle();
    await page.getByRole('link', { name: 'Piano Studio' }).first().click();
    await page.waitForURL(/\/studio/);
    await settle();
    check('Library → Settings → Privacy → Studio: single-page navigation (no reload), isolated', (await sameDoc()) && (await coi()));
    check('navigation steps: no console errors', true, takeErrors().join(' | ') || '');

    // 4. demo playback
    await page.goto(base + '/');
    await settle();
    await page.getByText('Try the demo').first().click();
    await page.waitForURL(/\/studio\/.+/, { timeout: 60000 });
    await settle();
    check('demo opens isolated studio', await coi());
    await page.getByRole('button', { name: /^Play/ }).first().click();
    await page.waitForTimeout(2500);
    const playing = await page.evaluate(() => !!document.querySelector('[aria-label^="Pause"]'));
    await page.getByRole('button', { name: /^Pause/ }).first().click().catch(() => undefined);
    check('demo playback runs', playing, takeErrors().join(' | '));

    // 5. background image upload
    if (image) {
      await page.getByRole('tab', { name: 'Look' }).first().click().catch(() => page.getByText('Look', { exact: true }).first().click());
      const bgSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Background', exact: true }) });
      await bgSection.getByRole('radio', { name: 'Image' }).click();
      await page.setInputFiles('input[aria-label="Upload background image"]', image);
      await page.waitForFunction((n) => [...document.querySelectorAll('button[aria-pressed]')].some((b) => b.textContent === n), path.basename(image), { timeout: 20000 });
      await page.waitForTimeout(1000);
      const errs = takeErrors();
      check('background image upload + render', errs.length === 0, errs.join(' | '));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'studio-bg.png') });
    }

    // 6. short video export (3 s, 720p30)
    {
      await page.getByRole('button', { name: /Export Video/ }).first().click();
      await page.getByRole('button', { name: /Render video/ }).click();
      const t0 = Date.now();
      await page.getByRole('button', { name: /Download/ }).first().waitFor({ timeout: 300000 });
      const info = await page.evaluate(() => document.querySelector('[role=dialog]')?.textContent?.match(/\d+×\d+ · [^·]+ · [\d.]+ MB · [A-Z0-9]+ \+ [A-Z0-9]+/)?.[0] ?? null);
      const preview = await page
        .waitForFunction(() => {
          const v = document.querySelector('video[aria-label="Rendered video preview"]');
          return v && v.readyState >= 1 && v.duration > 0 ? { duration: v.duration, w: v.videoWidth, h: v.videoHeight } : null;
        }, null, { timeout: 20000 })
        .then((h) => h.jsonValue())
        .catch(() => null);
      const errs = takeErrors();
      check('video export (3 s, 720p30) and its preview loads', !!info && !!preview && errs.length === 0, { info, preview, seconds: (Date.now() - t0) / 1000, errs });
      await page.keyboard.press('Escape');
    }

    }

    // 7. audio import with separation (Full song preset → "Separate vocals & drums" ticked)
    if (audio && !skipImport) {
      await page.goto(base + '/import');
      await settle();
      const sepBox = page.getByRole('checkbox', { name: /Separate vocals/ });
      const ticked = await sepBox.isChecked().catch(() => null);
      check('"Separate vocals & drums" is on by default for Full song', ticked === true, String(ticked));
      if (!ticked) await sepBox.check().catch(() => undefined);
      const rss = peakSampler(skip);
      const t0 = Date.now();
      await page.setInputFiles('input[type=file]', audio);
      const marks = {};
      let lastDetail = '';
      while (!/\/studio\//.test(page.url()) && Date.now() - t0 < 900000) {
        const d = await page.evaluate(() => document.querySelector('[aria-live=polite] p.mt-0\\.5')?.textContent ?? '').catch(() => '');
        if (d !== lastDetail) {
          lastDetail = d;
          if (verbose) console.error(`[import ${((Date.now() - t0) / 1000).toFixed(1)} s] ${d}`);
          const key = d.replace(/[\d.,]+/g, '#').replace(/ · .*$/, '');
          marks[key] ??= (Date.now() - t0) / 1000;
          if (/failed/i.test(d)) break;
        }
        await page.waitForTimeout(250);
      }
      const totalSec = (Date.now() - t0) / 1000;
      const peak = rss.stop();
      const sepStart = Object.entries(marks).find(([k]) => /Separating vocals/.test(k))?.[1];
      const sepEnd = Object.entries(marks).find(([k, v]) => v > (sepStart ?? Infinity) && !/Separating vocals/.test(k))?.[1];
      await settle().catch(() => undefined);
      const errs = takeErrors();
      summary.import = { totalSec, separatingSec: sepStart && sepEnd ? +(sepEnd - sepStart).toFixed(1) : null, rssBaseMB: Math.round(rss.base), rssPeakMB: peak, marks, loadavg: os.loadavg().map((x) => +x.toFixed(2)) };
      check('audio import with separation reaches the studio, isolated', /\/studio\//.test(page.url()) && (await coi()) && errs.length === 0, { ...summary.import, errs });
    }

    // 8. Back across a document boundary (to a page loaded on an unknown path) while an import runs:
    //    that is a page load, which would end the import, so the browser asks first (beforeunload);
    //    staying keeps it
    if (audio) {
      await page.goto(base + '/no-such-page');
      await settle();
      await page.goto(base + '/import?tab=audio');
      await settle();
      const sepBox = page.getByRole('checkbox', { name: /Separate vocals/ });
      const was = await sepBox.isChecked().catch(() => false);
      if (was) await sepBox.uncheck();
      await page.setInputFiles('input[type=file]', audio);
      await page.waitForSelector('[aria-live=polite]');
      await mark();
      await page.locator('h1').first().click(); // user activation: browsers only prompt on pages the user interacted with
      const dialogs = [];
      const onDialog = (d) => {
        dialogs.push(d.type());
        void d.dismiss(); // "stay on this page"
      };
      page.on('dialog', onDialog);
      // (short: the import must still be running when this is checked)
      await page.goBack({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const stayed = { dialogs: [...dialogs], url: await page.evaluate(() => location.href).catch(() => page.url()), pwUrl: page.url(), sameDoc: await sameDoc().catch(() => false), running: await page.evaluate(() => !!document.querySelector('[aria-live=polite]') && !/complete|failed/i.test(document.querySelector('[aria-live=polite]')?.textContent ?? '')).catch(() => false) };
      check('Back during an import: the browser asks first, staying keeps the import', stayed.dialogs.includes('beforeunload') && /tab=audio$/.test(stayed.url) && stayed.sameDoc && stayed.running, stayed);
      await page.waitForFunction(() => /\/studio\//.test(location.pathname) || /complete|failed/i.test(document.querySelector('[aria-live=polite]')?.textContent ?? ''), null, { timeout: 600000 });
      await settle();
      dialogs.length = 0;
      await page.goto(base + '/no-such-page');
      await settle();
      check('after the import: leaving the page does not ask', dialogs.length === 0 && /\/no-such-page$/.test(page.url()), { dialogs, url: page.url() });
      page.off('dialog', onDialog);
      if (was) {
        await page.goto(base + '/import');
        await settle();
        await page.getByRole('checkbox', { name: /Separate vocals/ }).check();
      }
      const errs = takeErrors();
      check('Back-during-import steps: no console errors', errs.length === 0, errs.join(' | '));
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(JSON.stringify({ summary, failures }, null, 1));
}

async function benchMode() {
  const audio = opt('audio', null);
  const port = +opt('port', '5392');
  const runs = (opt('runs', 'single,isolated') || 'single').split(',');
  if (!audio) throw new Error('--audio FILE is required');
  const { createServer } = await import('vite');
  const plugin = {
    name: 'isolation-audio',
    configureServer(srv) {
      srv.middlewares.use('/__isoaudio', (_req, res) => {
        res.setHeader('content-type', 'audio/mpeg');
        res.setHeader('content-length', fs.statSync(audio).size);
        fs.createReadStream(audio).pipe(res);
      });
    },
  };
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), plugins: [plugin], server: { port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const browser = await launch();
  const out = [];
  try {
    for (const run of runs) {
      const isolated = run === 'isolated';
      // fresh page per run: a separation worker's WASM heap is returned when it is terminated
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.error('[pageerror]', e.message));
      page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text().slice(0, 300)));
      await page.goto(`http://localhost:${port}/tests/e2e/isolation.html${isolated ? '?coi=1' : ''}`);
      await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
      const rss = peakSampler();
      const r = await page.evaluate((u) => window.bench(u), `http://localhost:${port}/__isoaudio`);
      r.run = run;
      r.rssBaseMB = Math.round(rss.base);
      r.rssPeakMB = rss.stop();
      r.loadavg = os.loadavg().map((x) => +x.toFixed(2));
      out.push(r);
      console.log(JSON.stringify(r));
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const one = out.find((r) => r.threads === 1);
  for (const r of out) if (one && r !== one) console.log(`threads ${r.threads}: ${r.secondsPerMinute} s/min vs ${one.secondsPerMinute} s/min single (×${(one.secondsPerMinute / r.secondsPerMinute).toFixed(2)}), peak RSS ${r.rssPeakMB} vs ${one.rssPeakMB} MB`);
}

try {
  if (mode === 'app') await appMode();
  else if (mode === 'bench') await benchMode();
  else {
    console.error('usage: node tests/e2e/isolation.mjs app|bench [options] (see the header of this file)');
    process.exit(2);
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}
process.exit(failures ? 1 : 0);
