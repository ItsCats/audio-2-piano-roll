// Offline melody / arrangement regeneration from saved app runs (no model inference, no browser).
//
// Input: JSON files written by a stems/separate run of the app pipeline that carry the saved
// posteriors (`posteriors` = accompaniment, `melodyPosteriors` = vocal stem, base64 of the
// app's StoredPosteriors), `duration` and `tempo`. The CURRENT src/ code re-extracts the
// accompaniment and the vocal melody line, merges them and generates Easy / Medium / Hard, so
// changes to melody.ts / difficulty.ts / hands.ts can be measured in seconds.
//
//   node tests/accuracy/melody_regen.mjs [--keep-base] [--preset mix] OUTDIR run1.json ...
//
//   --keep-base   regenerate the arrangements from the saved `base` notes (no re-extraction)
//   --preset P    accompaniment detection preset (default: the run's `preset`, else mix)
//   env MELODY_OPTS='{...}'  MelodyOptions overrides for extractMelody (e.g. '{"speech":null}')
//
// Output: OUTDIR/<basename> with duration, tempo, base, easy, medium, hard, `vocalNotes` (the
// cleaned vocal-stem notes before line reduction) and `speech` (rap / speech sections taken out of
// the melody line), for analysis. Song audio is never read.
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const keepBase = args.includes('--keep-base');
if (keepBase) args.splice(args.indexOf('--keep-base'), 1);
const presetArg = flag('--preset');
const [outDir, ...files] = args;
const melodyOpts = JSON.parse(process.env.MELODY_OPTS || '{}');
if (!outDir || !files.length) {
  console.error('usage: node tests/accuracy/melody_regen.mjs [--keep-base] [--preset P] OUTDIR run.json ...');
  process.exit(2);
}

const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' });
try {
  const P = await server.ssrLoadModule('/src/lib/transcription/pipeline.ts');
  const X = await server.ssrLoadModule('/src/lib/transcription/noteExtraction.ts');
  const M = await server.ssrLoadModule('/src/lib/music/melody.ts');
  const D = await server.ssrLoadModule('/src/lib/music/difficulty.ts');
  const PO = await server.ssrLoadModule('/src/lib/transcription/posteriors.ts');
  const u8 = (b) => new Uint8Array(Buffer.from(b, 'base64'));
  const f32 = (b) => {
    const u = u8(b);
    return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
  };
  const slim = (notes) =>
    notes.map((n) => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), vel: +n.vel.toFixed(3), hand: n.hand, ...(n.role ? { role: n.role } : {}) }));
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const t0 = Date.now();
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const tempo = { ...d.tempo, source: 'estimated' };
    let notes;
    let vocalNotes = [];
    let speech = [];
    if (keepBase || !d.posteriors) {
      let id = 1;
      notes = d.base.map((n) => ({ ...n, id: id++ }));
    } else {
      const params = P.EXTRACTION_PRESETS[presetArg || d.preset || 'mix'];
      const raw = (p, prm) => X.extractNotes(PO.dequantize(u8(p.frames)), PO.dequantize(u8(p.onsets)), p.nFrames, P.toWorkerOptions(prm));
      const accomp = P.cleanNotes(raw(d.posteriors, params), f32(d.posteriors.rms), params, d.duration);
      let melody = [];
      if (d.melodyPosteriors) {
        const vrms = f32(d.melodyPosteriors.rms);
        const vraw = raw(d.melodyPosteriors, P.VOCAL_EXTRACTION);
        vocalNotes = P.cleanNotes(vraw, vrms, P.VOCAL_EXTRACTION, d.duration);
        // = pipeline.ts melodyFromRaw (MIN_MELODY_NOTES = 8), with the speech sections kept
        const ex = M.extractMelody(vocalNotes, melodyOpts);
        melody = ex.line.length >= 8 ? ex.line : [];
        speech = ex.speech;
      }
      notes = M.mergeMelody(accomp, melody, d.duration);
    }
    const arr = D.generateAllArrangements(notes, [], tempo, d.duration);
    const out = {
      duration: d.duration,
      tempo: d.tempo,
      base: slim(notes),
      easy: slim(arr.easy.notes),
      medium: slim(arr.medium.notes),
      hard: slim(arr.hard.notes),
      vocalNotes: slim(vocalNotes),
      speech,
    };
    fs.writeFileSync(path.join(outDir, path.basename(f)), JSON.stringify(out));
    const mel = notes.filter((n) => n.role === 'melody').length;
    console.log(path.basename(f), `${notes.length} notes (${mel} melody)`, `E ${arr.easy.notes.length} M ${arr.medium.notes.length}`, `${Date.now() - t0} ms`);
  }
} finally {
  await server.close();
}
