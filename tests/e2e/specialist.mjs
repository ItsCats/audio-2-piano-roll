/**
 * End-to-end check of the high-accuracy piano model engine (the ByteDance piano model, ONNX in a
 * WASM worker, src/lib/pianoSpecialist) through the app's real transcribeAudio in Playwright Chromium.
 *
 *   node tests/e2e/specialist.mjs [--port 5181] [--no-coi] [--seconds 20] [--no-basic-pitch]
 *        [--maestro PIECE.wav [--excerpt START,DUR]] [--timeout-min 15]
 *
 * 1. support: pianoSpecialistSupport() reports the engine available in desktop Chromium, with a
 *    download size and a time estimate for the UI;
 * 2. synthetic: the demo prelude (first --seconds, default 20 s) rendered through the app's own piano
 *    engine, transcribed by the specialist (and by Basic Pitch for comparison, unless
 *    --no-basic-pitch); fails if the specialist's note F1 (onset ±50 ms) is below 0.90, if the result
 *    carries Basic Pitch posteriors, or if progress never reaches the end;
 * 3. cancel: aborting while the model analyses rejects with AbortError within 5 s;
 * 4. --maestro: an excerpt (default 30 s from 0:30) of a MAESTRO recording with its sibling .midi
 *    (exact performance MIDI, offsets extended by the sustain pedal as in tests/accuracy); fails below
 *    F1 0.85 (onset) for the specialist. MAESTRO is CC BY-NC-SA: pass it by path, never copy it here.
 *
 * The page is cross-origin isolated by default (?coi=1, like the shipped app routes) so the model gets
 * WASM threads; --no-coi measures the single-threaded fallback. One model run at a time.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
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
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const port = +opt('port', '5181');
const coi = !flag('no-coi');
const seconds = +opt('seconds', '20');
const withBP = !flag('no-basic-pitch');
const maestro = opt('maestro', null);
const [exStart, exDur] = opt('excerpt', '30,30').split(',').map(Number);
const timeoutMs = +opt('timeout-min', '15') * 60000;
const THRESH = { synthetic: 0.9, maestro: 0.85, abortMs: 5000 };

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

/** Performance MIDI → notes with sustain-pedal-extended offsets (tests/accuracy/acclib.py midi_notes). */
async function midiNotes(file) {
  const { Midi } = (await import('@tonejs/midi')).default;
  const midi = new Midi(fs.readFileSync(file));
  const rows = [];
  for (const tr of midi.tracks) {
    const pedal = [];
    let down = null;
    for (const cc of [...(tr.controlChanges[64] ?? [])].sort((a, b) => a.time - b.time)) {
      const v = cc.value * 127;
      if (v >= 64 && down === null) down = cc.time;
      else if (v < 64 && down !== null) {
        pedal.push([down, cc.time]);
        down = null;
      }
    }
    if (down !== null) pedal.push([down, midi.duration]);
    for (const n of tr.notes) {
      let end = n.time + n.duration;
      const p = pedal.find(([a, b]) => a <= end && end < b);
      if (p) end = p[1];
      rows.push({ midi: n.midi, start: n.time, end });
    }
  }
  // a re-struck pitch cuts the pedal-extended previous note
  rows.sort((a, b) => a.midi - b.midi || a.start - b.start);
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].midi === rows[i + 1].midi && rows[i].end > rows[i + 1].start) rows[i].end = Math.max(rows[i].start + 0.01, rows[i + 1].start);
  }
  return rows.sort((a, b) => a.start - b.start);
}

const serveAudio = {
  name: 'specialist-audio',
  configureServer(srv) {
    srv.middlewares.use('/__specaudio', (req, res) => {
      if (!maestro) return (res.statusCode = 404), res.end();
      res.setHeader('content-type', 'audio/wav');
      res.setHeader('content-length', fs.statSync(maestro).size);
      fs.createReadStream(maestro).pipe(res);
    });
  },
};
const withTimeout = (p, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${timeoutMs / 60000} min`)), timeoutMs)))]).finally(() => clearTimeout(t));
};
const line = (r) =>
  `${r.engine.padEnd(11)} F1 ${r.onset.f1} (P ${r.onset.precision} / R ${r.onset.recall}, ${r.onset.nEst}/${r.onset.nRef}) on+off F1 ${r.onsetOffset.f1} ` +
  `median onset err ${r.onset.medianOnsetErrMs} ms, ${(r.ms / 1000).toFixed(1)} s (${Object.entries(r.stagesMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(', ')}), ${r.backend}`;

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  plugins: [serveAudio],
  server: { port, strictPort: true },
  logLevel: 'error',
  ...(process.env.ACC_VITE_CACHE ? { cacheDir: path.resolve(process.env.ACC_VITE_CACHE) } : {}),
});
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
  await page.goto(`http://localhost:${port}/tests/e2e/specialist.html${coi ? '?coi=1' : ''}`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  const isolated = await page.evaluate(() => self.crossOriginIsolated);
  console.log(`page ${coi ? 'cross-origin isolated' : 'not isolated'} (crossOriginIsolated=${isolated}), ${(await page.evaluate(() => navigator.hardwareConcurrency))} cores`);

  const sup = await page.evaluate(() => window.support());
  check(sup.available === true && sup.downloadMB > 0 && sup.estSecondsPerMinute > 0, 'support    ', JSON.stringify(sup));

  const engines = withBP ? ['specialist', 'basic-pitch'] : ['specialist'];
  const syn = await withTimeout(page.evaluate(([s, e]) => window.runSynthetic(s, e), [seconds, engines]), 'synthetic run');
  const sp = syn.runs[0];
  console.log(`synthetic  ${syn.seconds} s of the demo prelude, ${syn.refNotes} reference notes`);
  for (const r of syn.runs) console.log(`  ${line(r)}`);
  check(sp.method === 'piano-specialist' && !sp.hasPosteriors, 'result     ', `method ${sp.method}, posteriors ${sp.hasPosteriors}, ${sp.notes} notes, velocity ${JSON.stringify(sp.velocityRange)}, hands ${JSON.stringify(sp.hands)}, ${sp.tempoBpm} BPM, ${sp.key}, warnings ${JSON.stringify(sp.warnings)}`);
  check(sp.maxProgress >= 0.99, 'progress   ', `reached ${sp.maxProgress}`);
  check(sp.onset.f1 >= THRESH.synthetic, 'synthetic F1', `${sp.onset.f1} >= ${THRESH.synthetic}`);

  const ab = await withTimeout(page.evaluate(() => window.runAbort(20)), 'cancel run');
  check(ab.rejected && ab.name === 'AbortError' && ab.abortedDuringAnalysis && ab.rejectAfterAbortMs <= THRESH.abortMs, 'cancel     ', JSON.stringify(ab));
  // the engine still works after a cancel (the worker was stopped and is started again)
  const again = await withTimeout(page.evaluate(() => window.runSynthetic(8, ['specialist'])), 'run after cancel');
  check(again.runs[0].notes > 0, 'after cancel', `${again.runs[0].notes} notes, F1 ${again.runs[0].onset.f1}`);

  if (maestro) {
    const midiFile = maestro.replace(/\.[^.]+$/, '.midi');
    const ref = (await midiNotes(midiFile)).filter((n) => n.start >= exStart - 10 && n.start <= exStart + exDur + 1);
    const ex = await withTimeout(page.evaluate(([r, s, d, e]) => window.runExcerpt('/__specaudio/0', r, s, d, e), [ref, exStart, exDur, engines]), 'MAESTRO excerpt');
    console.log(`maestro    ${path.basename(maestro)} ${ex.start}+${ex.seconds} s, ${ex.refNotes} reference notes`);
    for (const r of ex.runs) console.log(`  ${line(r)}`);
    check(ex.runs[0].onset.f1 >= THRESH.maestro, 'maestro F1 ', `${ex.runs[0].onset.f1} >= ${THRESH.maestro}`);
  }
} catch (err) {
  failed = true;
  console.error('FAIL', err.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
