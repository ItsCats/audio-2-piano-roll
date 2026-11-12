// Re-derive melody lines from saved crepe_track.mjs outputs without re-running any model
// (Node + jiti on the app's own TypeScript: src/lib/pitch/segment.ts, src/lib/music/melody.ts).
//
//   node tests/accuracy/crepe_lines.mjs --in DIR --out DIR2 [--variants tests/accuracy/crepe_variants.mjs | --variant JSON]
//
// Every variant is { name, source?: 'crepe'|'bp', voicingThreshold?, loudnessDb?, segment?, raw?: true (candidates only),
//   lite?: {...} (src/lib/pitch/line.ts crepeMelodyLine instead of melody.ts extractMelodyLine), speech?: null|{...},
//   split?: {...} (src/lib/pitch/hybrid.ts: split the line at Basic Pitch vocal onsets),
//   bpSpeech?: true (drop the rap / speech sections melody.ts finds on the Basic Pitch vocal notes) }.
// Writes DIR2/<id>.crepe.json = the input plus extra: { <name>: line notes } for crepe_eval.py score.
import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const jiti = createJiti(import.meta.url);
const { f0ToNotes } = await jiti.import(path.join(root, 'src/lib/pitch/segment.ts'));
const { medianFilter } = await jiti.import(path.join(root, 'src/lib/pitch/crepe.ts'));
const { extractMelodyLine, extractMelody, dropSections } = await jiti.import(path.join(root, 'src/lib/music/melody.ts'));
const { splitAtOnsets } = await jiti.import(path.join(root, 'src/lib/pitch/hybrid.ts'));
const { crepeMelodyLine } = await jiti.import(path.join(root, 'src/lib/pitch/line.ts'));

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const inDir = opt('--in');
const outDir = opt('--out');
let variants = [];
if (opt('--variants')) variants = (await import(path.resolve(opt('--variants')))).default;
if (opt('--variant')) variants.push(JSON.parse(opt('--variant')));
if (!variants.length) {
  variants = [
    { name: 'bpLineApp', source: 'bp' },
    { name: 'bpLineNoSpeech', source: 'bp', speech: null },
    { name: 'crepeLineNoSpeech', speech: null },
  ];
}
fs.mkdirSync(outDir, { recursive: true });

const f32 = (b) => {
  const u = Buffer.from(b, 'base64');
  return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4).slice();
};
const slim = (ns) => ns.map((n) => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), vel: +n.vel.toFixed(3), hand: n.hand, ...(n.role ? { role: n.role } : {}) }));

function voicing(per, rms, thr, db) {
  const p = medianFilter(per, 3);
  const s = Array.from(rms).filter((v) => v > 1e-7).sort((a, b) => a - b);
  const ref = s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0;
  const g = ref * 10 ** (db / 20);
  return Uint8Array.from(p, (v, i) => (ref > 0 && v >= thr && rms[i] >= g ? 1 : 0));
}

for (const f of fs.readdirSync(inDir).filter((x) => x.endsWith('.crepe.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8'));
  d.extra = {};
  const c = d.crepe;
  const raw = c && f32(c.rawF0);
  const per = c && f32(c.periodicity);
  const rms = c && f32(c.rms);
  for (const v of variants) {
    const melOpts = v.speech === undefined ? {} : { speech: v.speech };
    if (v.source === 'bp') {
      if (!d.bp) continue;
      const line = extractMelodyLine(d.bp.notes.map((n, i) => ({ ...n, id: i })), melOpts);
      d.extra[v.name] = slim(line.length >= 8 ? line : []);
      continue;
    }
    if (!c) continue;
    const mask = voicing(per, rms, v.voicingThreshold ?? 0.5, v.loudnessDb ?? -35);
    const f0 = Float32Array.from(raw, (x, i) => (mask[i] ? x : 0));
    const cand = f0ToNotes(f0, per, c.hop, v.segment ?? {});
    if (v.raw) {
      d.extra[v.name] = slim(cand);
      continue;
    }
    let line = v.lite ? crepeMelodyLine(cand, v.lite) : extractMelodyLine(cand, melOpts);
    if (v.split && d.bp) line = splitAtOnsets(line, d.bp.notes, v.split);
    // rap / speech sections found on the Basic Pitch vocal notes (melody.ts speechSections is tuned on them)
    if (v.bpSpeech && d.bp) line = dropSections(line, extractMelody(d.bp.notes.map((n, i) => ({ ...n, id: i }))).speech);
    d.extra[v.name] = slim(line.length >= 8 ? line : []);
  }
  fs.writeFileSync(path.join(outDir, f), JSON.stringify(d));
  console.log(f, Object.entries(d.extra).map(([k, v]) => `${k}:${v.length}`).join(' '));
}
