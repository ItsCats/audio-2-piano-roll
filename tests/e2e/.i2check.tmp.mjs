import { createServer } from 'vite';
const { chromium } = await import('playwright');
const server = await createServer({ root: '/home/user/audio-2-piano-roll', server: { port: 5347, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.error('[console]', m.type(), m.text().slice(0, 300)));
  page.on('worker', (w) => w.on('console', (m) => console.error('[worker]', m.text().slice(0, 300))));
  await page.goto('http://localhost:5347/tests/e2e/harness.html');
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 300000 });
  for (const piece of ['bach', 'chords']) {
    const r = await page.evaluate((p) => window.runAccuracy(p, 'piano'), piece);
    console.log(piece, JSON.stringify(r.score));
  }
} finally { await browser.close(); await server.close(); }
