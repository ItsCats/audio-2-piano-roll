/**
 * The privacy promise, checked in a browser: playing the demo song and opening the main pages
 * sends no request to any host other than the site itself, and sets no cookies.
 * The allow-list for this path is empty. If this fails, either fix the request or update the
 * Privacy page (src/pages/Legal.tsx) first and then this test.
 * (A processing server set in Settings, or built in with VITE_PROCESSING_URL, does contact another
 * host by design; the Privacy page says so. It is not on this path.)
 *
 *   npm run test:e2e:privacy             against the dev server
 *   npm run test:e2e:privacy -- --dist   against the production build in dist/ (run `npm run build` first;
 *                                        --dist=<folder> for a build elsewhere)
 */
import { createServer, preview } from 'vite';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

/** other hosts this path may contact: none */
const ALLOWED_HOSTS = [];

const PORT = 5186;
const distArg = process.argv.find((a) => a === '--dist' || a.startsWith('--dist='));
const useDist = !!distArg;
const server = useDist
  ? await preview({ build: { outDir: distArg.split('=')[1] || 'dist' }, preview: { port: PORT, strictPort: true }, logLevel: 'error' })
  : await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
if (!useDist) await server.listen();
const origin = `http://localhost:${PORT}`;
const ownHost = new URL(origin).host;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const offending = [];
let requests = 0;
let failed = false;
const check = (ok, what) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const record = (url) => {
    requests++;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return;
    if (u.host === ownHost || ALLOWED_HOSTS.includes(u.hostname)) return;
    offending.push(url);
  };
  // every request of the pages and their workers (Chromium reports dedicated workers' fetches to the page)
  ctx.on('request', (r) => record(r.url()));
  ctx.on('page', (p) => p.on('websocket', (ws) => record(ws.url())));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Play the demo' }).click();
  await page.locator('[aria-label^="Song position"]').waitFor({ timeout: 60000 });
  // playing loads the piano sounds
  await page.getByRole('button', { name: 'Play (Space)' }).click();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Pause (Space)' }).click();

  // the other pages, through the app's own navigation
  for (const [link, heading] of [
    ['My Library', null],
    ['Settings', null],
    ['How accurate is it?', null],
    ['Credits & licenses', null],
    ['Privacy', 'Privacy'],
    ['Terms', 'Terms of use'],
    ['Copyright', 'Copyright'],
  ]) {
    await page.getByRole('link', { name: link, exact: true }).first().click();
    if (heading) await page.getByRole('heading', { level: 1, name: heading }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
  }
  // every tab of the Import page (with a processing server, opening Import checks it: not set here)
  for (const tab of ['audio', 'computer', 'midi', 'record']) {
    await page.goto(`${origin}/import?tab=${tab}`);
    await page.getByRole('heading', { level: 1, name: 'Import music' }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
  }
  // an old link to the removed YouTube tab loads nothing from YouTube
  await page.goto(`${origin}/import/youtube`);
  await page.waitForURL(/\/import\?tab=computer/, { timeout: 15000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  check(requests > 0, `requests seen: ${requests}`);
  check(offending.length === 0, `requests to other hosts: ${new Set(offending).size}`);
  for (const u of [...new Set(offending)].slice(0, 20)) console.log(`  -> ${u}`);
  const cookies = await ctx.cookies();
  check(cookies.length === 0, `cookies set: ${cookies.length}${cookies.length ? ` (${cookies.map((c) => `${c.domain} ${c.name}`).join(', ')})` : ''}`);
  await ctx.close();
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
