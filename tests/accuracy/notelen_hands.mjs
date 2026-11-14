/**
 * Helper of tests/accuracy/notelen_eval.py: runs the app's own TypeScript (through Vite's SSR loader,
 * no browser) on note lists, so the scoring uses the same hands and automatic pedal as the app.
 *
 *   node tests/accuracy/notelen_hands.mjs IN.json OUT.json
 *
 * IN: [{ op: 'hands', notes: [{midi, start, dur}], duration } | { op: 'autopedal', notes: [{midi, start, dur, hand}], bpm, duration }, ...]
 * OUT: one result per job: the hands ('L' | 'R', in the input order) or the pedal ranges.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [inp, out] = process.argv.slice(2);
if (!inp || !out) {
  console.error('usage: node tests/accuracy/notelen_hands.mjs IN.json OUT.json');
  process.exit(2);
}
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { assignHands } = await server.ssrLoadModule('/src/lib/music/hands.ts');
  const { autoPedal } = await server.ssrLoadModule('/src/lib/music/autoPedal.ts');
  const jobs = JSON.parse(fs.readFileSync(inp, 'utf8'));
  const res = jobs.map((j) => {
    const notes = j.notes.map((n, i) => ({ id: i + 1, vel: 0.6, hand: 'R', ...n }));
    if (j.op === 'hands') {
      const byId = new Map(assignHands(notes, j.duration).map((n) => [n.id, n.hand]));
      return notes.map((n) => byId.get(n.id));
    }
    if (j.op === 'autopedal') return autoPedal(notes, { bpm: j.bpm }, j.duration);
    throw new Error(`unknown op ${j.op}`);
  });
  fs.writeFileSync(out, JSON.stringify(res));
} finally {
  await server.close();
}
