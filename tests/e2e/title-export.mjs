/**
 * Exports with a title page / end card keep everything after the title exactly in sync.
 *
 *   node tests/e2e/title-export.mjs [--keep DIR]
 *
 * A synthetic song (notes at 1.0 s and 2.0 s) is exported at 720p / 30 fps with no lead-in or fades:
 * A without cards, B with a 2.5 s title page, C with the title page and a 3 s end card. Checks
 * (decoded with ffmpeg): the first audible sample of B is 2.5 s ± 1 ms after A's; frame N of A
 * matches frame N + 75 of B in the roll; B's early frames differ from A's; B lasts A + 2.5 s and C
 * A + 5.5 s (± 1 frame), and C's audio is silent after the music. Requires ffmpeg.
 */
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const keep = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : null;
const SR = 48000;
const { chromium } = await import('playwright');
const dir = keep ?? mkdtempSync(join(tmpdir(), 'title-export-'));
mkdirSync(dir, { recursive: true });
const server = await createServer({ server: { port: 5398, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
const check = (name, ok, info = '') => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
};
const pcm = (file) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const W = 320, H = 180;
const frames = (file) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  const n = b.byteLength / (W * H);
  return Array.from({ length: n }, (_, i) => b.subarray(i * W * H, (i + 1) * W * H));
};
const mad = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
const firstAudible = (x) => {
  const thr = 10 ** (-30 / 20);
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr) return i / SR;
  return null;
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.exposeFunction('saveChunk', (name, b64) => appendFileSync(join(dir, name), Buffer.from(b64, 'base64')));
  await page.goto('http://localhost:5398/tests/e2e/title-export.html');
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 120000 });
  const A = await page.evaluate(() => window.runExport('a.mp4', {}));
  const B = await page.evaluate(() => window.runExport('b.mp4', { title: 2.5 }));
  const C = await page.evaluate(() => window.runExport('c.mp4', { title: 2.5, end: 3 }));
  for (const r of [A, B, C]) console.log(`  ${r.name}: ${r.duration.toFixed(3)} s, ${r.videoCodec}+${r.audioCodec}, ${(r.bytes / 1e6).toFixed(2)} MB in ${(r.ms / 1000).toFixed(1)} s${r.warnings.length ? ' warnings: ' + r.warnings.join(' | ') : ''}`);
  check('no warnings (fonts loaded)', !B.warnings.length && !C.warnings.length);
  const fa = join(dir, 'a.mp4'), fb = join(dir, 'b.mp4'), fc = join(dir, 'c.mp4');
  const xa = pcm(fa), xb = pcm(fb), xc = pcm(fc);
  const oa = firstAudible(xa), ob = firstAudible(xb), oc = firstAudible(xc);
  check('audio: first note 2.5 s later with the title page', oa !== null && ob !== null && Math.abs(ob - oa - 2.5) <= 0.001, `A ${oa?.toFixed(4)} s, B ${ob?.toFixed(4)} s`);
  check('audio: same with an end card too', oc !== null && Math.abs(oc - oa - 2.5) <= 0.001, `C ${oc?.toFixed(4)} s`);
  const da = duration(fa), db = duration(fb), dc = duration(fc);
  check('duration: B = A + 2.5 s', Math.abs(db - da - 2.5) <= 1 / 30 + 1e-3, `A ${da.toFixed(3)} B ${db.toFixed(3)}`);
  check('duration: C = A + 5.5 s', Math.abs(dc - da - 5.5) <= 1 / 30 + 1e-3, `C ${dc.toFixed(3)}`);
  check('audio track covers the end card', Math.abs(xc.length / SR - dc) <= 0.05, `audio ${(xc.length / SR).toFixed(3)} s`);
  // the music (and its 1.5 s tail) is over 2.5 + A seconds in; after that C must be silent
  let peakAfter = 0;
  for (let i = Math.round((2.5 + da + 0.05) * SR); i < xc.length; i++) peakAfter = Math.max(peakAfter, Math.abs(xc[i]));
  check('end card is silent', peakAfter < 10 ** (-60 / 20), `peak ${(20 * Math.log10(peakAfter + 1e-12)).toFixed(1)} dBFS`);
  const va = frames(fa), vb = frames(fb), vc = frames(fc);
  const diffs = [];
  for (const n of [0, 5, 15, 30, 45, 60, 80, 100].filter((n) => n < va.length && n + 75 < vb.length)) diffs.push([n, mad(va[n], vb[n + 75]) / 255, mad(va[n], vc[n + 75]) / 255]);
  check('video: roll frame N of A = frame N + 75 of B and C', diffs.every(([, d1, d2]) => d1 < 2 / 255 && d2 < 2 / 255), diffs.map(([n, d1, d2]) => `${n}:${(d1 * 255).toFixed(2)}/${(d2 * 255).toFixed(2)}`).join(' '));
  const early = [10, 30, 50].map((n) => mad(va[0], vb[n]) / 255);
  check('video: the title page is there', early.every((d) => d > 4 / 255), early.map((d) => (d * 255).toFixed(1)).join(' '));
  const endFrame = vc[Math.round((2.5 + da + 1.5) * 30)];
  check('video: the end card is there', endFrame && mad(endFrame, va[va.length - 1]) / 255 > 2 / 255);
  check('frame counts', vb.length - va.length === 75 && vc.length - va.length === 165, `${va.length} ${vb.length} ${vc.length}`);
} finally {
  await browser.close();
  await server.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
