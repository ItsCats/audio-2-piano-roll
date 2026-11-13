/**
 * Runs the TypeScript homr port (src/lib/omr/homr) in Node on raw page images and writes MusicXML +
 * intermediate results, for the comparison with Python homr (tests/homr/compare.py) and the scores
 * (tests/homr/score_out.sh). Not part of `npm test`; run with
 *
 *   HOMR_RAW=<dir of <cat>/<name>.rgb + .json> HOMR_MODELS=<dir with segnet/encoder/decoder .onnx>
 *   HOMR_OUT=<out dir> [HOMR_ONLY=gen00,25EF-01] [HOMR_THREADS=3] [HOMR_VARIANT=int8]
 *   npx vitest run --config tests/homr/vitest.parity.config.ts
 *
 * (raw images: tests/homr/to_raw.py, decoded by OpenCV like homr does)
 */
import { it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-web';
import { ortInfer, type InferStats } from '../../src/lib/omr/homr/ort';
import { readPage, pagesToMusicXml, type PageDump } from '../../src/lib/omr/homr/pipeline';
import type { RotatedBoundingBox } from '../../src/lib/omr/homr/boxes';

const RAW = process.env.HOMR_RAW ?? '';
const MODELS = process.env.HOMR_MODELS ?? '';
const OUT = process.env.HOMR_OUT ?? '';
const ONLY = (process.env.HOMR_ONLY ?? '').split(',').filter(Boolean);
const CATS = (process.env.HOMR_CATS ?? 'clean,clean_real,photo,photo_real').split(',');
const VARIANT = process.env.HOMR_VARIANT ?? 'int8';

it('homr TypeScript port on the test set', { timeout: 24 * 3600 * 1000 }, async () => {
  ort.env.wasm.numThreads = Number(process.env.HOMR_THREADS ?? 3);
  const file = (name: string) => {
    const v = process.env[`HOMR_${name.toUpperCase()}`] ?? `${name}.${name === 'decoder' ? 'orig' : VARIANT}.onnx`;
    return readFileSync(v.startsWith('/') ? v : join(MODELS, v));
  };
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' as const, enableCpuMemArena: false, enableMemPattern: false };
  const sessions = {
    segnet: await ort.InferenceSession.create(file('segnet'), opt),
    encoder: await ort.InferenceSession.create(file('encoder'), opt),
    decoder: await ort.InferenceSession.create(file('decoder'), opt),
  };
  for (const cat of CATS) {
    const dir = join(RAW, cat);
    mkdirSync(join(OUT, cat), { recursive: true });
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const name = f.replace(/\.json$/, '');
      if (ONLY.length && !ONLY.some((o) => name.startsWith(o))) continue;
      const { w, h } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const d = new Uint8Array(readFileSync(join(dir, `${name}.rgb`)));
      const stats: InferStats = { segmentMs: 0, encodeMs: 0, decodeMs: 0, steps: 0, windows: 0, staffs: 0 };
      const dump: PageDump = {};
      const t0 = performance.now();
      let xml = '';
      let error = '';
      try {
        const r = await readPage({ w, h, c: 3, d }, ortInfer(ort, sessions, stats), { dump });
        xml = pagesToMusicXml([r.xml]);
        writeFileSync(join(OUT, cat, `${name}.musicxml`), xml);
      } catch (e) {
        error = String(e);
      }
      const ms = performance.now() - t0;
      const box = (b: RotatedBoundingBox) => [b.box[0], b.box[1], b.box[2]];
      writeFileSync(
        join(OUT, cat, `${name}.ts.json`),
        JSON.stringify({
          error,
          ms,
          stats,
          crop: dump.crop,
          resized: dump.resized,
          unit: dump.unit,
          staffCount: dump.staffCount,
          systems: dump.systems,
          boxes: dump.boxes ? Object.fromEntries(Object.entries(dump.boxes).map(([k, v]) => [k, v.map(box)])) : undefined,
          tokens: dump.tokens,
          voices: dump.voices,
        }),
      );
      if (process.env.HOMR_DUMP_IMAGES && dump.classes) {
        writeFileSync(join(OUT, cat, `${name}.classes.u8`), dump.classes);
        (dump.staffImages ?? []).forEach((im, i) => writeFileSync(join(OUT, cat, `${name}.staff${i}.u8`), im.d));
      }
      process.stderr.write(`${cat}/${name} ${error || 'ok'} ${(ms / 1000).toFixed(1)}s seg ${(stats.segmentMs / 1000).toFixed(1)}s enc ${(stats.encodeMs / 1000).toFixed(1)}s dec ${(stats.decodeMs / 1000).toFixed(1)}s staffs ${stats.staffs} steps ${stats.steps}\n`);
    }
  }
});
