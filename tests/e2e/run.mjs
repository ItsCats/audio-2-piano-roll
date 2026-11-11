/**
 * Browser accuracy benchmark: renders pieces with known notes through the real piano
 * engine, transcribes them with the real pipeline and fails if note-onset F1 regresses.
 *
 *   npm run test:e2e
 *
 * Requires Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
 */
import { createServer } from 'vite';

const THRESHOLDS = { bach: 0.92, chords: 0.86 };

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const server = await createServer({ server: { port: 5179, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:5179/tests/e2e/harness.html');
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 120000 });
  for (const piece of ['bach', 'chords']) {
    const r = await page.evaluate((p) => window.runAccuracy(p, 'piano'), piece);
    const ok = r.score.f1 >= THRESHOLDS[piece];
    failed ||= !ok;
    const reOk = r.redetect.sameNotes && r.redetect.sameTempo;
    failed ||= !reOk;
    console.log(`${reOk ? 'PASS' : 'FAIL'} ${piece.padEnd(7)} re-detect with the import's parameters reproduces its notes and tempo ${JSON.stringify(r.redetect)}`);
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${piece.padEnd(7)} F1 ${r.score.f1} (P ${r.score.precision} / R ${r.score.recall}) ` +
        `onset ${r.score.meanOffsetMs} ms (early ${r.score.earlyOffsetMs} / late ${r.score.lateOffsetMs}) ` +
        `tempo ${r.tempo.bpm} BPM, key ${r.key}, ${r.backend}, ${r.transcribeMs} ms`,
    );
  }
  // a reused in-page separation result is not consumed (its buffers are copied, not transferred)
  const reuse = await page.evaluate(() => window.runSeparationReuse());
  const reuseOk = reuse.intact && reuse.notes[0] > 0 && reuse.notes[0] === reuse.notes[1] && reuse.melody[0] === reuse.melody[1];
  failed ||= !reuseOk;
  console.log(`${reuseOk ? 'PASS' : 'FAIL'} separation  the same in-page separation result transcribes twice identically ${JSON.stringify(reuse)}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
