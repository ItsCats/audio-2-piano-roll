/**
 * End-to-end check of "Full song + piano model" (transcription/pipeline.ts pianoBlend, music/pianoBlend.ts)
 * through the app's real transcribeAudio in Playwright Chromium, on a synthetic band render (the demo
 * prelude on the app's piano + a bass line + drums), separated once in the page (SCNet) and reused:
 *
 *   node tests/e2e/blend.mjs [--port 5182] [--no-coi] [--seconds 20] [--timeout-min 15]
 *
 * 1. blend off: the Full song result, no piano-model fields;
 * 2. blend on: completes, the 'piano-model' stage reaches the end, status 'ok', its notes are stored
 *    with the posteriors, and every note of the blend-off result is still there (pitch, start,
 *    velocity, hand, role; a held tune note may end where a lead note was added after it);
 * 3. cancel while the piano model analyzes: rejects with AbortError within 5 s;
 * 4. forced failure (a model URL that does not exist): completes with the failure notice, status
 *    'failed', and exactly the blend-off notes.
 * One model run at a time (the runner is a heavy job).
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const port = +opt('port', '5182');
const coi = !args.includes('--no-coi');
const seconds = +opt('seconds', '20');
const timeoutMs = +opt('timeout-min', '15') * 60000;
const { chromium } = await import('playwright');
const withTimeout = (p, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), timeoutMs)))]).finally(() => clearTimeout(t));
};
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'error', ...(process.env.ACC_VITE_CACHE ? { cacheDir: path.resolve(process.env.ACC_VITE_CACHE) } : {}) });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
const check = (ok, label, detail) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(`http://localhost:${port}/tests/e2e/blend.html${coi ? '?coi=1' : ''}`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  const prep = await withTimeout(page.evaluate((s) => window.prepare(s), seconds), 'separation');
  console.log(`prepared   ${JSON.stringify(prep)}`);
  check(prep.bass && !prep.vocals, 'separation ', 'bass stem, no singing');

  const off = await withTimeout(page.evaluate(() => window.run(false)), 'blend off');
  check(off.pianoBlend === null && off.specialistStored === 0 && off.added === 0 && !off.stages.includes('piano-model'), 'blend off  ', `${off.notes.length} notes, stages ${off.stages.join(' > ')}`);

  const on = await withTimeout(page.evaluate(() => window.run(true)), 'blend on');
  // pitch, start, velocity, hand and role of every blend-off note are kept; a held tune note may end
  // earlier where a lead note was added in the hole after it (music/sustain.ts holds up to the next line note)
  const key = (n) => n.split(' ').filter((_, i) => i !== 2).join(' ');
  const offSet = new Set(off.notes.map(key));
  const kept = on.notes.filter((n) => !n.endsWith(' piano'));
  const unchanged = kept.length === off.notes.length && kept.every((n) => offSet.has(key(n)));
  const shorter = kept.filter((n) => !off.notes.includes(n)).length;
  console.log(`blend on   ${on.notes.length} notes (${on.added} added), ${JSON.stringify(on.pianoBlend)}, ${(on.ms / 1000).toFixed(1)} s, stages ${on.stages.join(' > ')}, details ${JSON.stringify(on.details)}`);
  check(on.pianoBlend?.status === 'ok' && on.specialistStored > 0, 'blend on   ', `status ${on.pianoBlend?.status}, ${on.specialistStored} piano-model notes stored`);
  check(on.stages.includes('piano-model') && on.maxBlendProgress >= 0.99, 'progress   ', `piano-model stage reached ${on.maxBlendProgress}`);
  check(unchanged, 'app notes  ', unchanged ? `every blend-off note kept (pitch, start, velocity, hand, role; ${shorter} held shorter)` : `${kept.length} vs ${off.notes.length}; first differences ${JSON.stringify(kept.filter((n) => !offSet.has(n)).slice(0, 3))}`);

  const ab = await withTimeout(page.evaluate(() => window.runCancel()), 'cancel');
  check(ab.rejected && ab.name === 'AbortError' && ab.abortedDuringBlend && ab.rejectAfterAbortMs <= 5000, 'cancel     ', JSON.stringify(ab));

  const bad = await withTimeout(page.evaluate(() => window.run(true, { pianoModelUrl: '/models/piano-specialist/does-not-exist.onnx' })), 'forced failure');
  const same = bad.notes.length === off.notes.length && bad.notes.every((n, i) => n === off.notes[i]);
  check(bad.pianoBlend?.status === 'failed' && bad.failedNotice && same, 'failure    ', `status ${bad.pianoBlend?.status}, notice ${bad.failedNotice}, notes ${same ? 'equal to blend off' : 'DIFFER'}`);
} catch (err) {
  failed = true;
  console.error('FAIL', err.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
