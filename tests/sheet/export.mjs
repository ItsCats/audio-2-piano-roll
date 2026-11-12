/**
 * Writes MusicXML (+ our quantized notes as JSON) for songs, for tests/sheet/validate_musicxml.py.
 * Loads the app's own code through Vite (src/lib/sheet), so nothing is duplicated.
 *
 *   node tests/sheet/export.mjs OUT_DIR file.mid|transcription.json …
 *
 * - .mid: parsed and arranged like a MIDI import (Easy/Medium/Hard).
 * - .json: a saved transcription with `tempo`, `key`, `duration` and `easy`/`medium`/`hard` note
 *   lists (the accuracy scripts' format); a tempo without `source` counts as estimated.
 * - `--demo`: the built-in demo song.
 * Outputs go to OUT_DIR only (keep it outside the repo: songs may be copyrighted).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outDir, ...inputs] = process.argv.slice(2);
if (!outDir || !inputs.length) {
  console.error('usage: node tests/sheet/export.mjs OUT_DIR (file.mid | transcription.json | --demo) …');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', resolve: { alias: { '@tonejs/midi': path.join(root, 'tests/sheet/tonejs-midi-shim.mjs') } }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const sheet = await server.ssrLoadModule('/src/lib/sheet/index.ts');
  const songs = await server.ssrLoadModule('/src/lib/songs.ts');
  const midi = await server.ssrLoadModule('/src/lib/music/midi.ts');
  for (const input of inputs) {
    let items;
    if (input === '--demo') {
      const s = songs.demoSong();
      items = [{ id: 'demo', s }];
    } else if (input.endsWith('.mid') || input.endsWith('.midi')) {
      const buf = fs.readFileSync(input);
      const parsed = midi.parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      items = [{ id: path.basename(input).replace(/\.midi?$/, ''), s: songs.songFromMidi(parsed, path.basename(input), buf.length) }];
    } else {
      const d = JSON.parse(fs.readFileSync(input, 'utf8'));
      const tempo = { ...d.tempo, source: d.tempo.source ?? 'estimated' };
      const arr = (notes) => ({ notes, pedal: [], edited: false, generatedAt: 0 });
      const s = { title: 'Test piece', tempo, key: d.key, duration: d.duration, arrangements: { easy: arr(d.easy), medium: arr(d.medium), hard: arr(d.hard) } };
      items = [{ id: path.basename(input).replace(/\.json$/, ''), s }];
    }
    for (const { id, s } of items) {
      for (const level of ['easy', 'medium', 'hard']) {
        const t0 = performance.now();
        const score = sheet.buildSheet(s, level);
        const xml = sheet.toMusicXml(score, { title: 'Test piece', artist: 'Test & "artist" <1>', credits: true, breaks: sheet.systemBreaks(score, 18) });
        const ms = performance.now() - t0;
        const t = score.time;
        const notes = score.staves.flatMap((sv) =>
          sv.voices.flatMap((v) =>
            v.flatMap((c) => {
              const m = t.measureOf(c.on);
              return c.midis.map((mi) => ({ midi: mi, staff: sv.staff, measure: m, offset: (c.on - t.measureStart(m)) / 12, dur: (c.off - c.on) / 12 }));
            }),
          ),
        );
        const name = `${id}-${level}`;
        fs.writeFileSync(path.join(outDir, name + '.musicxml'), xml);
        fs.writeFileSync(
          path.join(outDir, name + '.quant.json'),
          JSON.stringify({ level, measures: score.measureCount, measureLenQ: t.measureLen / 12, pickupQ: t.pickup / 12, notes }),
        );
        console.log(`${name}: ${s.arrangements[level].notes.length} notes → ${score.measureCount} measures, ${t.beatsPerBar}/${t.beatUnit}, ${ms.toFixed(0)} ms`);
      }
    }
  }
} finally {
  await server.close();
}
