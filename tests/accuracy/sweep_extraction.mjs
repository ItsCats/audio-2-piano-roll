/**
 * Node-side detection-parameter sweep on stored Basic Pitch posteriors (no model inference).
 *
 *   node tests/accuracy/transcribe.mjs --dump-posteriors POST maestro/*.wav     # once, in the browser
 *   node tests/accuracy/sweep_extraction.mjs --post POST --ref MAESTRO_DIR [--configs FILE.mjs] [--json OUT.json] [--pieces a,b]
 *
 * Runs the app's own extractNotes() (noteExtraction.ts) and cleanNotes() (pipeline.ts) through Vite's
 * SSR loader on the dumped posteriors, exactly as the app re-detects after a preset change, and scores
 * every candidate with mir_eval-style onset-only note F1 (pitch exact, onset within 50 ms) against the
 * exact MAESTRO performance MIDI (<ref>/<piece>.midi). Also reports recall by octave and the median
 * onset bias (estimate - reference over matched notes) used to calibrate ONSET_LATENCY.
 *
 * A config is { name, preset: 'piano'|'sensitive'|'mix', params?: Partial<ExtractionParams>,
 * extraction?: Partial<NoteExtractionOptions> (e.g. register), latency?: seconds }. --configs FILE.mjs
 * must default-export an array of configs (or a function (presets) => configs); without it the
 * stock 'piano' and 'sensitive' presets are scored.
 *
 * Nothing here touches audio: posteriors and references stay where they are (outside the repo).
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ToneMidi from '@tonejs/midi';

const { Midi } = ToneMidi;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const postDir = opt('post', null);
const refDir = opt('ref', null);
const configFile = opt('configs', null);
const jsonOut = opt('json', null);
const tol = +opt('tol', '0.05');
/** ONSET_LATENCY currently applied by pipeline.ts cleanNotes(); a config's `latency` shifts relative to it. */
const APP_LATENCY = +opt('app-latency', '0');
const TUNE = ['m-debussy-pas-neige', 'm-bach-bwv850', 'm-mozart-k280-1', 'm-chopin-noct15-1', 'm-chopin-ballade1'];
const HOLDOUT = ['m-liszt-waldesrauschen'];
/** Synthetic e2e benchmark (sweep_extraction.e2e.mjs --dump): reported separately, gates Bach >= 0.93, chords >= 0.87. */
const E2E = ['e2e-bach', 'e2e-chords'];
const pieces = (opt('pieces', null)?.split(',') ?? [...TUNE, ...HOLDOUT, ...E2E]).filter((p) => fs.existsSync(path.join(postDir ?? '', `${p}.post.json`)));
if (!postDir || !refDir || !pieces.length) {
  console.error('usage: node tests/accuracy/sweep_extraction.mjs --post DIR --ref DIR [--configs FILE.mjs] [--json OUT] [--pieces a,b] [--tol 0.05]');
  process.exit(2);
}

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { extractNotes } = await server.ssrLoadModule('/src/lib/transcription/noteExtraction.ts');
const { cleanNotes, toWorkerOptions, EXTRACTION_PRESETS } = await server.ssrLoadModule('/src/lib/transcription/pipeline.ts');
const { dequantize } = await server.ssrLoadModule('/src/lib/transcription/posteriors.ts');

// ------------------------------------------------------------------ data
const data = pieces.map((name) => {
  const meta = JSON.parse(fs.readFileSync(path.join(postDir, `${name}.post.json`), 'utf8'));
  const u8 = (ext) => new Uint8Array(fs.readFileSync(path.join(postDir, `${name}.${ext}`)));
  const rmsBuf = fs.readFileSync(path.join(postDir, `${name}.rms.f32`));
  const rms = new Float32Array(rmsBuf.buffer.slice(rmsBuf.byteOffset, rmsBuf.byteOffset + rmsBuf.byteLength));
  const midiPath = path.join(refDir, `${name}.midi`);
  const ref = fs.existsSync(midiPath)
    ? new Midi(fs.readFileSync(midiPath)).tracks.flatMap((t) => t.notes.map((n) => ({ midi: n.midi, start: n.time })))
    : JSON.parse(fs.readFileSync(path.join(postDir, `${name}.ref.json`), 'utf8'));
  return { name, meta, frames: dequantize(u8('frames.u8')), onsets: dequantize(u8('onsets.u8')), rms, ref: byPitch(ref) };
});

function byPitch(notes) {
  const m = new Map();
  for (const n of notes) {
    if (!m.has(n.midi)) m.set(n.midi, []);
    m.get(n.midi).push(n.start);
  }
  for (const a of m.values()) a.sort((x, y) => x - y);
  return m;
}

/**
 * Onset-only note matching, pitch exact, |onset diff| <= tol. Per pitch this is a bipartite
 * matching on a line with a fixed window, where the greedy two-pointer matching is maximum
 * (same count as mir_eval's Hopcroft-Karp).
 */
function score(refMap, est) {
  const estMap = byPitch(est);
  let nRef = 0;
  let nEst = est.length;
  let hit = 0;
  const diffs = [];
  const octRef = new Array(9).fill(0);
  const octHit = new Array(9).fill(0);
  const octEst = new Array(9).fill(0);
  const octEstHit = new Array(9).fill(0);
  for (const n of est) octEst[Math.floor(n.midi / 12) - 1]++;
  for (const [p, r] of refMap) {
    nRef += r.length;
    const o = Math.floor(p / 12) - 1;
    octRef[o] += r.length;
    const e = estMap.get(p) ?? [];
    let j = 0;
    for (const t of r) {
      while (j < e.length && e[j] < t - tol - 1e-9) j++;
      if (j < e.length && e[j] <= t + tol + 1e-9) {
        hit++;
        octHit[o]++;
        octEstHit[o]++;
        diffs.push(e[j] - t);
        j++;
      }
    }
  }
  const P = nEst ? hit / nEst : 0;
  const R = nRef ? hit / nRef : 0;
  diffs.sort((a, b) => a - b);
  return {
    P,
    R,
    F: P + R ? (2 * P * R) / (P + R) : 0,
    nEst,
    nRef,
    hit,
    biasMs: diffs.length ? diffs[Math.floor(diffs.length / 2)] * 1000 : 0,
    meanBiasMs: diffs.length ? (diffs.reduce((s, d) => s + d, 0) / diffs.length) * 1000 : 0,
    // index o = octave starting at C(o) (0: A0-B0, 1: C1-B1, ... 8: C8)
    octRef,
    octHit,
    octEst,
    recallByOctave: octRef.map((c, i) => (c ? +(octHit[i] / c).toFixed(3) : null)),
    precisionByOctave: octEst.map((c, i) => (c ? +(octEstHit[i] / c).toFixed(3) : null)),
  };
}

function transcribe(d, cfg) {
  // { browser: 'piano' | 'sensitive' | 'pianoFirstPass' } scores the notes the browser produced in the dump run
  if (cfg.browser) return d.meta.notes?.[cfg.browser]?.map((n) => ({ midi: n.midi, start: n.start })) ?? null;
  const params = { ...EXTRACTION_PRESETS[cfg.preset ?? 'piano'], ...(cfg.params ?? {}) };
  const wopts = { ...toWorkerOptions(params), ...(cfg.extraction ?? {}) };
  const raw = extractNotes(d.frames, d.onsets, d.meta.nFrames, wopts);
  // frames let cleanNotes apply the re-strike rule exactly as the app does (RESTRIKE / frameRise)
  const notes = cleanNotes(raw, d.rms, params, d.meta.duration, { frames: d.frames, nFrames: d.meta.nFrames });
  const shift = cfg.latency === undefined ? 0 : APP_LATENCY - cfg.latency;
  return notes.map((n) => ({ midi: n.midi, start: Math.max(0, n.start + shift) }));
}

let configs = [
  { name: 'browser: piano first pass (float)', browser: 'pianoFirstPass' },
  { name: 'browser: piano re-detect', browser: 'piano' },
  { name: 'browser: sensitive re-detect', browser: 'sensitive' },
  { name: 'piano (current)', preset: 'piano' },
  { name: 'sensitive (current)', preset: 'sensitive' },
];
if (configFile) {
  const mod = await import(pathToFileURL(path.resolve(configFile)).href);
  configs = typeof mod.default === 'function' ? mod.default(EXTRACTION_PRESETS) : mod.default;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const results = [];
const t0 = Date.now();
for (const cfg of configs) {
  const per = {};
  for (const d of data) {
    const est = transcribe(d, cfg);
    // (synthetic e2e-* pieces have no browser notes: a `browser` config skips them)
    if (est) per[d.name] = score(d.ref, est);
  }
  const tune = TUNE.filter((p) => per[p]).map((p) => per[p]);
  const hold = HOLDOUT.filter((p) => per[p]).map((p) => per[p]);
  const row = {
    name: cfg.name,
    config: cfg,
    tuneF: mean(tune.map((s) => s.F)),
    tuneP: mean(tune.map((s) => s.P)),
    tuneR: mean(tune.map((s) => s.R)),
    holdF: hold.length ? mean(hold.map((s) => s.F)) : null,
    e2e: Object.fromEntries(E2E.filter((p) => per[p]).map((p) => [p, per[p].F])),
    per,
  };
  results.push(row);
  console.log(
    `${cfg.name.padEnd(44)} tune F ${row.tuneF.toFixed(4)} (P ${row.tuneP.toFixed(3)} R ${row.tuneR.toFixed(3)})` +
      (row.holdF !== null ? `  liszt F ${row.holdF.toFixed(4)}` : '') +
      Object.entries(row.e2e)
        .map(([k, f]) => `  ${k} ${f.toFixed(3)}`)
        .join('') +
      '  | ' +
      Object.entries(per)
        .map(([k, s]) => `${k.replace(/^m-/, '').slice(0, 8)} ${s.F.toFixed(3)}`)
        .join(' ') +
      `  | median onset bias, MAESTRO mean ${mean([...TUNE, ...HOLDOUT].filter((p) => per[p]).map((p) => per[p].biasMs)).toFixed(1)} ms`,
  );
}
console.error(`${configs.length} configs x ${data.length} pieces in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
await server.close();
