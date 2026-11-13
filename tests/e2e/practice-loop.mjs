/**
 * Practice on an A-B loop (src/state/practiceRuntime.ts, src/lib/midiInput/practice.ts) in the
 * demo song, production build served with the netlify.toml rules:
 *  - with an 8 s loop and no keys pressed, every pass is scored: the stage shows "Pass N · …"
 *    and the misses of each pass are counted again (before the fix only the first pass was);
 *  - "Wait for me" holds at the first note, and again after jumping back to the loop start.
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/practice-loop.mjs --dist /tmp/p2v-dist [--port 5398]
 */
import { spawn } from 'node:child_process';
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
const dist = path.resolve(opt('dist', 'dist'));
const port = Number(opt('port', '5398'));
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
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Play the demo' }).click();
  const position = page.locator('[aria-label^="Song position"]');
  await position.waitFor();
  await page.waitForTimeout(1500);
  const playBtn = page.getByRole('button', { name: /^(Play|Pause) \(Space\)$/ });
  const playing = async () => (await playBtn.getAttribute('aria-label')) === 'Pause (Space)';
  if (await playing()) await playBtn.click();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await page.getByRole('button', { name: /Loop section/ }).click(); // [now, now + 8 s]
  await page.getByRole('button', { name: 'Start practice' }).click();
  const badge = page.locator('[data-practice-badge]');
  check('stage shows the pass', /Pass 1/.test((await badge.textContent()) ?? ''), await badge.textContent());
  await playBtn.click();
  // read the badge and the missed count just before each wrap
  const seen = [];
  let lastPass = 1;
  let lastMissed = 0;
  const until = Date.now() + 36_000;
  // badge and panel read in one go (a wrap between two reads would mix two passes)
  const read = () =>
    page.evaluate(() => {
      const label = [...document.querySelectorAll('aside div')].find((d) => d.textContent === 'missed');
      return { text: document.querySelector('[data-practice-badge]')?.textContent ?? '', m: Number(label?.previousElementSibling?.textContent) };
    });
  while (Date.now() < until) {
    const { text, m } = await read();
    const pass = Number(/Pass (\d+)/.exec(text)?.[1] ?? 0);
    if (pass !== lastPass) {
      seen.push({ pass: lastPass, missed: lastMissed, badge: text });
      lastPass = pass;
    }
    lastMissed = m;
    await page.waitForTimeout(150);
  }
  await playBtn.click();
  console.log('passes:', JSON.stringify(seen));
  check('four passes or more in 36 s of an 8 s loop', seen.length >= 3 && lastPass >= 4, `last pass ${lastPass}`);
  const counts = seen.map((s) => s.missed);
  check('the misses are counted on every pass', counts.length >= 3 && counts.every((c) => c > 5 && Math.abs(c - counts[0]) <= 3), JSON.stringify(counts));
  check('stage shows the best earlier pass', /\(best \d+(\.\d)?%\)/.test((await badge.textContent()) ?? ''), await badge.textContent());

  // Wait for me: holds at the first note, and again after a jump back to the loop start
  await page.getByRole('button', { name: 'Stop practice' }).click();
  await page.getByText('Wait for me').click();
  await page.getByRole('button', { name: /Back to start/ }).click();
  await page.getByRole('button', { name: 'Start practice' }).click();
  const pos = async () => position.getAttribute('aria-valuetext');
  await playBtn.click();
  await page.waitForTimeout(2500);
  const held1 = await pos();
  await page.waitForTimeout(1500);
  const held2 = await pos();
  check('Wait for me holds at a note while playing', (await playing()) && held1 === held2, `${held1} / ${held2}`);
  await page.getByRole('button', { name: /Back to start/ }).click();
  await page.waitForTimeout(2500);
  const held3 = await pos();
  await page.waitForTimeout(1500);
  const held4 = await pos();
  check('…and holds again after jumping back', (await playing()) && held3 === held4 && held3 === held1, `${held3} / ${held4}`);
  await playBtn.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const box = await badge.boundingBox();
  check('the stage badge fits on a phone', !!box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  if (opt('shot')) await page.screenshot({ path: opt('shot') });
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
