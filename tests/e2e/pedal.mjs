/**
 * Listening proxy for the automatic pedal (src/lib/music/autoPedal.ts): a choppy passage, as note
 * detection from audio gives it, rendered offline through the real piano engine with and without
 * the pedal. With it the notes ring on between the key presses; in a rest they do not.
 *
 *   node tests/e2e/pedal.mjs [--port 5181]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const i = process.argv.indexOf('--port');
const port = i > 0 ? Number(process.argv[i + 1]) : 5181;
const server = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/tests/e2e/pedal.html`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 120000 });
  const r = await page.evaluate(() => window.runPedal());
  console.log(JSON.stringify({ ...r, ranges: r.ranges.map((p) => `${p.start}-${p.end}`).join(' ') }));
  check('Medium and Hard get pedal, Easy none', r.pedal.easy === 0 && r.pedal.medium > 0 && r.pedal.hard > 0, JSON.stringify(r.pedal));
  check('the pedal reaches the player (down + up events)', r.pedalEvents === 2 * r.pedal.hard, `${r.pedalEvents} events`);
  check('notes ring on between the key presses', r.gapRms.ratio > 2, `gap level ×${r.gapRms.ratio.toFixed(1)} with the pedal`);
  check('a rest stays a rest', r.restRms.wet <= r.restRms.dry * 1.5 + 1e-4, `${r.restRms.wet.toExponential(2)} vs ${r.restRms.dry.toExponential(2)}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
