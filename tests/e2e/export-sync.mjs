/**
 * Video export with the original recording: checks that the recording is sample-aligned with the
 * notes in the exported file (MP4 and WebM, full range and a custom range starting mid-song).
 *
 *   npm run test:e2e:export
 *
 * The page (export-sync.ts) exports a synthetic song whose "recording" is a click track with a short
 * 6 kHz burst exactly at every note. This script decodes each file's audio with ffmpeg, finds the
 * clicks and checks every expected click is within 10 ms of where the picture shows the note, that
 * there are no extra clicks, and that the audio is as long as the video. In "Both" mode it also
 * checks the piano notes start with the clicks. Synthetic audio only.
 *
 * Requires Playwright with Chromium and ffmpeg on the PATH.
 */
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SR = 48000;
const TOL_MS = 10;
// the piano's samples need ~10–18 ms to reach 30 % of their peak (natural attack; the first audible
// sample is on the note), so the piano is checked against the clicks with a looser tolerance
const PIANO_TOL_MS = 20;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg is needed to decode the exported files.');
  process.exit(2);
}

const CASES = [
  { name: 'mp4-full', patch: { format: 'mp4', range: 'full', leadIn: 2, fadeIn: 0, fadeOut: 2, sound: 'original' } },
  { name: 'webm-full', patch: { format: 'webm', range: 'full', leadIn: 2, fadeIn: 0, fadeOut: 2, sound: 'original' } },
  { name: 'mp4-custom', patch: { format: 'mp4', range: 'custom', customStart: 4.3, customEnd: 9, leadIn: 2, fadeIn: 0.5, fadeOut: 1, sound: 'original' } },
  { name: 'webm-custom', patch: { format: 'webm', range: 'custom', customStart: 4.3, customEnd: 9, leadIn: 2, fadeIn: 0.5, fadeOut: 1, sound: 'original' } },
  { name: 'webm-both', patch: { format: 'webm', range: 'full', leadIn: 2, fadeIn: 0, fadeOut: 2, sound: 'both' } },
  { name: 'mp4-both', patch: { format: 'mp4', range: 'full', leadIn: 2, fadeIn: 0, fadeOut: 2, sound: 'both' } },
];

/** RBJ biquad (high-pass or low-pass), applied in place. */
function biquad(x, type, f0, q = 0.7071) {
  const w = (2 * Math.PI * f0) / SR;
  const a = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const b0 = type === 'hp' ? (1 + c) / 2 : (1 - c) / 2;
  const b1 = type === 'hp' ? -(1 + c) : 1 - c;
  const b2 = b0;
  const a0 = 1 + a;
  const a1 = -2 * c;
  const a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Click onsets: first sample above 25 % of the peak with no such sample in the 150 ms before it. */
function clickOnsets(y) {
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  const hi = 0.25 * peak;
  const gap = Math.round(0.15 * SR);
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < y.length; i++) {
    if (Math.abs(y[i]) <= hi) continue;
    if (i - last > gap) out.push(i / SR);
    last = i;
  }
  return out;
}

/** Piano note onset near `t`: first sample above 30 % of the note's own peak (within 60 ms after t). */
function pianoOnset(y, t) {
  const from = Math.max(0, Math.round((t - 0.05) * SR));
  const to = Math.min(y.length, Math.round((t + 0.06) * SR));
  let peak = 0;
  for (let i = Math.round(t * SR); i < to; i++) peak = Math.max(peak, Math.abs(y[i]));
  for (let i = from; i < to; i++) if (Math.abs(y[i]) > 0.3 * peak) return i / SR;
  return null;
}

const fadeGain = (o, d, fi, fo) => Math.max(0, Math.min(1, fi > 0 ? o / fi : 1, fo > 0 ? (d - o) / fo : 1));
const envelope = (o, d, fi, fo) => Math.min(fadeGain(o, d, fi, fo), Math.max(0, (d - o) / 0.3));

const dir = mkdtempSync(join(process.env.EXPORT_SYNC_DIR ?? tmpdir(), 'export-sync-'));
const server = await createServer({ server: { port: 5183, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.exposeFunction('saveChunk', (name, b64) => appendFileSync(join(dir, name), Buffer.from(b64, 'base64')));
  await page.goto('http://localhost:5183/tests/e2e/export-sync.html');
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 120000 });
  const noteTimes = await page.evaluate(() => window.noteTimes);
  for (const c of CASES) {
    const file = `${c.name}.${c.patch.format}`;
    const r = await page.evaluate(({ file, patch }) => window.runExport(file, patch), { file, patch: c.patch });
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
    const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    const audioDur = x.length / SR;

    // expected clicks: every note whose song time is heard (lead-in included), at lead + (t - start)
    const { start, end } = r.range;
    const expected = [];
    for (const t of noteTimes) {
      if (t < Math.max(0, start - r.lead)) continue;
      const o = r.lead + (t - start);
      const g = envelope(o, r.duration, r.fadeIn, r.fadeOut);
      if (o >= r.duration || g <= 0) continue;
      expected.push({ t, o, required: g >= 0.3 });
    }
    const found = clickOnsets(biquad(x, 'hp', 4000));
    const used = new Set();
    const errs = [];
    let caseOk = true;
    for (const e of expected) {
      let best = -1;
      for (let i = 0; i < found.length; i++) if (!used.has(i) && (best < 0 || Math.abs(found[i] - e.o) < Math.abs(found[best] - e.o))) best = i;
      const errMs = best >= 0 ? (found[best] - e.o) * 1000 : Infinity;
      if (Math.abs(errMs) <= TOL_MS) {
        used.add(best);
        errs.push(errMs);
      } else if (e.required) {
        caseOk = false;
        console.log(`  missing click for note ${e.t.toFixed(3)} s at ${e.o.toFixed(4)} s (nearest ${errMs.toFixed(1)} ms)`);
      }
    }
    const extra = found.filter((_, i) => !used.has(i));
    if (extra.length) {
      caseOk = false;
      console.log(`  extra clicks at ${extra.map((v) => v.toFixed(4)).join(', ')} s`);
    }
    const durOk = Math.abs(audioDur - r.duration) <= 0.05;
    caseOk &&= durOk;
    let pianoInfo = '';
    if (r.sound === 'both') {
      const lp = biquad(x, 'lp', 1000);
      const perr = [];
      for (const t of noteTimes) {
        if (t < start - 0.001 || t > end) continue;
        const o = r.lead + (t - start);
        const p = pianoOnset(lp, o);
        const ms = p === null ? Infinity : (p - o) * 1000;
        perr.push(ms);
        if (!(Math.abs(ms) <= PIANO_TOL_MS)) {
          caseOk = false;
          console.log(`  piano note ${t.toFixed(3)} s starts ${ms.toFixed(1)} ms off the click`);
        }
      }
      pianoInfo = ` · piano vs click ${Math.min(...perr).toFixed(1)}..${Math.max(...perr).toFixed(1)} ms`;
    }
    const abs = errs.map(Math.abs);
    failed ||= !caseOk;
    console.log(
      `${caseOk ? 'PASS' : 'FAIL'} ${c.name.padEnd(11)} ${r.videoCodec}+${r.audioCodec} ${r.sound} · ${errs.length}/${expected.length} clicks matched` +
        ` (${expected.filter((e) => e.required).length} required), error ${errs.length ? Math.min(...errs).toFixed(2) : '-'}..${errs.length ? Math.max(...errs).toFixed(2) : '-'} ms` +
        ` (max |${abs.length ? Math.max(...abs).toFixed(2) : '-'}| ms) · audio ${audioDur.toFixed(3)} s vs video ${r.duration.toFixed(3)} s${pianoInfo} · ${(r.bytes / 1e6).toFixed(1)} MB in ${(r.ms / 1000).toFixed(1)} s`,
    );
  }
} finally {
  await browser.close();
  await server.close();
  if (!process.env.EXPORT_SYNC_KEEP) rmSync(dir, { recursive: true, force: true });
  else console.log(`files kept in ${dir}`);
}
process.exit(failed ? 1 : 0);
