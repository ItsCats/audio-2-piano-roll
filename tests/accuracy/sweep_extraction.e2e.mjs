/**
 * Checks candidate detection configs on the synthetic e2e benchmark (tests/e2e/harness.ts: Bach
 * prelude + chord study rendered through the app's piano engine) without editing the presets.
 *
 *   node tests/accuracy/sweep_extraction.e2e.mjs [--configs FILE.mjs] [--port 5343]
 *
 * Renders each piece once, runs the model once ('piano' preset), then re-detects on the stored
 * posteriors for every config with the app's own worker (extract message, so `extraction`
 * overrides such as `register` reach extractNotes even before pipeline.ts maps them) and
 * cleanNotes(), and scores with the harness's scoreNotes(). Same config format as
 * sweep_extraction.mjs ({ name, preset, params?, extraction?, latency? }).
 * The e2e gate (npm run test:e2e) runs the FIRST pass on float posteriors; this re-detects on the
 * 8-bit stored ones, which matches it to within ~0.005 F1 since flat onset peaks are handled.
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const port = +opt('port', '5343');
const configFile = opt('configs', null);
const APP_LATENCY = +opt('app-latency', '0.007');
let configs = [
  { name: 'piano (current)', preset: 'piano' },
  { name: 'sensitive (current)', preset: 'sensitive' },
];
if (configFile) {
  const mod = await import(pathToFileURL(path.resolve(configFile)).href);
  configs = typeof mod.default === 'function' ? mod.default() : mod.default;
}

const { chromium } = await import('playwright');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/tests/e2e/harness.html`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  const out = await page.evaluate(
    async ([cfgs, appLatency]) => {
      const { transcribeAudio, cleanNotes, toWorkerOptions, transcriber, EXTRACTION_PRESETS } = await import('/src/lib/transcription/pipeline.ts');
      const { bachPreludeDemo } = await import('/src/lib/music/demo.ts');
      const { renderOffline } = await import('/src/lib/audio/offlineRender.ts');
      const { WavWriter } = await import('/src/lib/audio/wav.ts');
      const { DEFAULT_AUDIO_SETTINGS } = await import('/src/lib/audio/types.ts');
      const { newNoteId } = await import('/src/lib/music/cleanup.ts');
      // copy of harness.ts chordPiece() (module-local there)
      const chordPiece = () => {
        const notes = [];
        const beat = 0.5;
        const prog = [
          [48, 55, 64, 67, 72], [45, 52, 60, 64, 69], [41, 48, 57, 60, 65], [43, 50, 59, 62, 67],
        ];
        const melody = [76, 74, 72, 74, 76, 76, 76, 74, 74, 74, 76, 79, 79, 77, 76, 74];
        const t = 0.3;
        for (let rep = 0; rep < 4; rep++) {
          prog.forEach((chord, ci) => {
            const t0 = t + (rep * 4 + ci) * 4 * beat;
            notes.push({ id: newNoteId(), midi: chord[0], start: t0, dur: 4 * beat - 0.05, vel: 0.6, hand: 'L' });
            notes.push({ id: newNoteId(), midi: chord[0] - 12, start: t0, dur: 4 * beat - 0.05, vel: 0.6, hand: 'L' });
            for (let b = 0; b < 4; b++) {
              for (const m of chord.slice(1, 3)) notes.push({ id: newNoteId(), midi: m, start: t0 + b * beat, dur: beat * 0.8, vel: 0.45, hand: 'L' });
              const mel = melody[(ci * 4 + b) % melody.length];
              notes.push({ id: newNoteId(), midi: mel, start: t0 + b * beat, dur: beat * 0.9, vel: 0.75, hand: 'R' });
            }
          });
        }
        return { notes, duration: t + 16 * 4 * beat + 1, pedal: [] };
      };
      const results = {};
      for (const piece of ['bach', 'chords']) {
        const src = piece === 'bach' ? bachPreludeDemo() : chordPiece();
        const settings = { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'hall' };
        const audio = await renderOffline({ notes: src.notes, pedal: src.pedal, settings, start: 0, end: src.duration, rate: 1, sampleRate: 44100 });
        const wav = new WavWriter(44100);
        wav.append(audio);
        const res = await transcribeAudio(wav.finish(), EXTRACTION_PRESETS.piano, () => {});
        const post = res.posteriors;
        results[piece] = { firstPass: window.scoreNotes(src.notes, res.notes), configs: [] };
        for (const cfg of cfgs) {
          const params = { ...EXTRACTION_PRESETS[cfg.preset ?? 'piano'], ...(cfg.params ?? {}) };
          const frames = post.frames.slice();
          const onsets = post.onsets.slice();
          const r = await transcriber.run(
            { type: 'extract', frames, onsets, nFrames: post.nFrames, options: { ...toWorkerOptions(params), ...(cfg.extraction ?? {}) } },
            [frames.buffer, onsets.buffer],
            () => {},
            undefined,
            'extracted',
          );
          const shift = cfg.latency === undefined ? 0 : appLatency - cfg.latency;
          const notes = cleanNotes(r.notes, post.rms, params, res.duration).map((n) => ({ ...n, start: Math.max(0, n.start + shift) }));
          results[piece].configs.push({ name: cfg.name, score: window.scoreNotes(src.notes, notes) });
        }
      }
      return results;
    },
    [configs, APP_LATENCY],
  );
  for (const [piece, r] of Object.entries(out)) {
    const s = r.firstPass;
    console.log(`${piece.padEnd(7)} first pass (current piano preset, float posteriors): F1 ${s.f1} (P ${s.precision} / R ${s.recall}) onset ${s.meanOffsetMs} ms`);
    for (const c of r.configs) console.log(`${piece.padEnd(7)} ${c.name.padEnd(40)} F1 ${c.score.f1} (P ${c.score.precision} / R ${c.score.recall}) onset ${c.score.meanOffsetMs} ms`);
  }
} finally {
  await browser.close();
  await server.close();
}
