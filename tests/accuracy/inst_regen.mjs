// Offline arrangement regeneration from saved base transcriptions (no model, no browser, no audio).
//
// Loads ONLY src/lib/music/difficulty.ts (and what it imports) through Vite's SSR loader, so the
// Easy / Medium / Hard generators can be measured in seconds after a change, also while other
// parts of the app are being edited.
//
//   node tests/accuracy/inst_regen.mjs OUTDIR run1.json ...
//
// Input: any JSON with `base` (notes), `tempo` (TempoInfo; `beats` optional) and `duration`:
// a transcribe.mjs run, a melody_regen.mjs output or a saved song. Output: OUTDIR/<basename> with
// duration, tempo, base, easy, medium, hard (and the generation time). Song audio is never read.
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outDir, ...files] = process.argv.slice(2);
if (!outDir || !files.length) {
  console.error('usage: node tests/accuracy/inst_regen.mjs OUTDIR run.json ...');
  process.exit(2);
}
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' });
try {
  const D = await server.ssrLoadModule('/src/lib/music/difficulty.ts');
  const slim = (notes) =>
    notes.map((n) => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), vel: +n.vel.toFixed(3), hand: n.hand, ...(n.role ? { role: n.role } : {}) }));
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const tempo = { beatsPerBar: 4, downbeatIndex: 0, confidence: 0.5, beats: [], ...d.tempo, source: 'estimated' };
    let id = 1;
    const base = d.base.map((n) => ({ ...n, id: id++ }));
    const t0 = performance.now();
    const arr = D.generateAllArrangements(base, [], tempo, d.duration);
    const ms = performance.now() - t0;
    const out = { duration: d.duration, tempo: d.tempo, base: slim(base), easy: slim(arr.easy.notes), medium: slim(arr.medium.notes), hard: slim(arr.hard.notes), ms };
    fs.writeFileSync(path.join(outDir, path.basename(f)), JSON.stringify(out));
    const mel = base.filter((n) => n.role === 'melody').length;
    console.log(path.basename(f), `${base.length} notes (${mel} melody)`, `E ${arr.easy.notes.length} M ${arr.medium.notes.length} H ${arr.hard.notes.length}`, `${ms.toFixed(0)} ms`);
  }
} finally {
  await server.close();
}
