/**
 * Hands video export, frame by frame (dev server, like title-export.mjs):
 *
 *   node tests/e2e/handcam-export.mjs [--keep DIR]
 *
 * A synthetic hands video (tests/e2e/handcam-video.mjs: tilted 88-key keyboard, VFR, rotation
 * metadata, keys turn green while their tone sounds) is exported under a song with the same notes,
 * "hands at the bottom" + watermark, 720p30, with the video's own sound. Checks on the decoded file
 * (ffmpeg): every lit key in the video band lines up with its note's lane (< 0.25 white key); the tone
 * and the first green frame agree within one frame; the watermark is where its layout says (and absent
 * when off); the length is lead-in + song + tail. Requires ffmpeg.
 */
import { createServer } from 'vite';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeHandsVideo, makeNotes, sourceFrameTimes, toneOnset, QUAD } from './handcam-video.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : null;
const SR = 48000;
const FPS = 30;
const { chromium } = await import('playwright');
const dir = keep ?? mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'handcam-export-'));
mkdirSync(dir, { recursive: true });
let failed = false;
const check = (name, ok, info = '') => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
};

const SECONDS = 12;
const notes = makeNotes(SECONDS);
const video = join(dir, 'hands.mp4');
await makeHandsVideo({ out: video, notes, seconds: SECONDS });

/**
 * Decodes a video (RGB) and keeps only the frames `want(i)` asks for; returns them and the frame count.
 * Streams, so a long file never sits in memory whole.
 */
export function rgbFrames(file, W, H, want = () => true) {
  return new Promise((resolve, reject) => {
    const size = W * H * 3;
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const kept = new Map();
    let buf = Buffer.alloc(0);
    let i = 0;
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) {
        if (want(i)) kept.set(i, Buffer.from(buf.subarray(0, size)));
        buf = buf.subarray(size);
        i++;
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ frames: kept, count: i }) : reject(new Error(`ffmpeg ${code}`))));
  });
}
const pcm = (file) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const onsetNear = (x, t) => toneOnset(x, SR, t);
const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
/** x centroid of green-lit pixels on row y of an RGB frame */
const green = (f, W, y, x0 = 0, x1 = W) => {
  let sx = 0;
  let n = 0;
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x++) {
    const i = (y * W + x) * 3;
    const r = f[i], g = f[i + 1], b = f[i + 2];
    if (g > 100 && g > r + 60 && g > b + 40) {
      sx += x;
      n++;
    }
  }
  return n ? sx / n : null;
};

const server = await createServer({ server: { port: 5399, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.exposeFunction('saveChunk', (name, b64) => appendFileSync(join(dir, name), Buffer.from(b64, 'base64')));
  await page.exposeFunction('getVideo', (name) => readFileSync(join(dir, name)).toString('base64'));
  await page.goto('http://localhost:5399/tests/e2e/handcam-export.html');
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 120000 });
  const base = { video: 'hands.mp4', notes, duration: SECONDS, quad: QUAD, offset: 0, layout: 'bottom', sound: 'hands' };
  // A: the measurement export (key light and sparkles off, so the lit keys are seen as they are)
  const A = await page.evaluate((o) => window.runExport('a.mp4', o), { ...base, watermark: {}, patch: { handsKeyLight: false, handsSparkles: false } });
  console.log(`  a: ${A.duration.toFixed(3)} s ${A.videoCodec}+${A.audioCodec} ${(A.bytes / 1e6).toFixed(2)} MB in ${(A.ms / 1000).toFixed(1)} s; probe ${JSON.stringify(A.probe)}; phases ${A.phases.join(',')}`);
  check('probe: rotation 90, shown 640×360', A.probe.rotation === 90 && A.probe.displayW === 640 && A.probe.displayH === 360);
  check('progress shows the video decoding and its sound', A.phases.includes('handsVideo') && A.phases.includes('handsAudio'));
  const fa = join(dir, 'a.mp4');
  const W = A.width, H = A.height, g = A.geom;
  // the frames the checks look at: around every note, and the middle of the song
  const mid = Math.round((A.lead + 5) * FPS);
  const wanted = new Set([mid]);
  for (const n of notes) for (let k = -8; k <= 12; k++) wanted.add(Math.round((A.lead + n.start) * FPS) + k);
  const { frames, count } = await rgbFrames(fa, W, H, (i) => wanted.has(i));
  const audio = pcm(fa);
  const whiteW = g.s / 52;
  const rowFor = (midi) => Math.round(g.yTop + ([1, 3, 6, 8, 10].includes(midi % 12) ? 0.4 : 0.8) * g.kh);
  // (a) lanes over the lit keys
  const errs = [];
  for (const n of notes) {
    const fi = Math.round((A.lead + n.start + 0.15) * FPS);
    const x = frames.has(fi) ? green(frames.get(fi), W, rowFor(n.midi)) : null;
    errs.push(x === null ? Infinity : Math.abs(x - A.lanes[n.midi]) / whiteW);
  }
  const worst = Math.max(...errs);
  check('lanes line up with the lit keys (< 0.25 white key)', worst < 0.25, `worst ${worst.toFixed(3)} key, mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(3)} (${notes.length} notes)`);
  // (b) sound and picture. The camera only shows a key lit from its first frame at or after the note
  // (the source is ~30 FPS with jitter and a dropped frame), so the exact export shows it on the first
  // output frame whose video time reaches that camera frame. Checked: the tone sits at its note time
  // (sample-exact mixing), and the first lit output frame is that frame (within one frame).
  const srcTimes = sourceFrameTimes({ seconds: SECONDS, fps: 30 });
  const shownAt = (tv) => {
    let k = -1;
    for (let j = 0; j < srcTimes.length && srcTimes[j] <= tv + 1e-6; j++) k = j;
    return k < 0 ? null : srcTimes[k];
  };
  const toneErr = [];
  const picErr = [];
  for (const n of notes) {
    const exp = A.lead + n.start;
    const on = onsetNear(audio, exp);
    toneErr.push(on === null ? Infinity : on - exp);
    // the first output frame an exact export shows lit
    let want = null;
    for (let fi = Math.round((exp - 0.2) * FPS); fi < (exp + 0.3) * FPS; fi++) {
      const ts = shownAt(fi / FPS - A.lead);
      if (ts !== null && ts >= n.start && ts < n.start + n.dur) {
        want = fi;
        break;
      }
    }
    let first = null;
    for (let fi = Math.round((exp - 0.2) * FPS); fi < (exp + 0.3) * FPS; fi++) {
      const x = frames.has(fi) ? green(frames.get(fi), W, rowFor(n.midi), A.lanes[n.midi] - whiteW, A.lanes[n.midi] + whiteW) : null;
      if (x !== null) {
        first = fi;
        break;
      }
    }
    picErr.push(want === null || first === null ? Infinity : first - want);
  }
  check('sound at the note times (sample-exact, < 3 ms)', toneErr.every((e) => Math.abs(e) < 0.003), toneErr.map((e) => (e * 1000).toFixed(1)).join(' ') + ' ms');
  check('picture: each camera frame on the right output frame (within one frame)', picErr.every((e) => Math.abs(e) <= 1), picErr.join(' ') + ' frames');
  // (c) watermark pixels
  const bright = (f, w, b) => {
    let n = 0;
    let s = 0;
    for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(H, b.y + b.h); y++)
      for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(w, b.x + b.w); x++) {
        const i = (y * w + x) * 3;
        if (f[i] + f[i + 1] + f[i + 2] > 3 * 110) n++;
        s++;
      }
    return n / Math.max(1, s);
  };
  const inWm = bright(frames.get(mid), W, A.wm);
  check('watermark drawn where its layout says (under the video band)', inWm > 0.015 && A.wm.y > g.yTop + g.bandH - 2, `${(inWm * 100).toFixed(1)}% bright pixels in its box`);
  // (d) length
  const d = duration(fa);
  check('length = lead-in + song + tail', Math.abs(d - (A.lead + SECONDS + 1.5)) <= 1 / FPS + 0.03, `${d.toFixed(3)} s`);
  check('frame count', Math.abs(count - Math.ceil((A.lead + SECONDS + 1.5) * FPS)) <= 1, `${count}`);
  if (keep) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(A.lead + 5), '-i', fa, '-frames:v', '1', join(dir, 'measure.png')]);

  // B: picture-in-picture, WebM, a title page, the watermark top right; 4 s of the song
  const B = await page.evaluate((o) => window.runExport('b.webm', o), { ...base, layout: 'pip', title: 2, watermark: { position: 'tr' }, patch: { format: 'webm', range: 'custom', customStart: 2, customEnd: 6 } });
  const fb = join(dir, 'b.webm');
  const bMid = Math.round((2 + B.lead + 2) * FPS);
  const fr = await rgbFrames(fb, B.width, B.height, (i) => i === bMid || i === 10 || i === Math.round((2 + B.lead + 0.5) * FPS));
  check('WebM picture-in-picture export with a title page', fr.count > 0 && B.videoCodec !== 'avc' && !B.warnings.length, `${B.videoCodec}+${B.audioCodec} ${B.warnings.join(' ')}`);
  check('B: length = title + lead-in + 4 s + tail', Math.abs(duration(fb) - (2 + B.lead + 4 + 1.5)) <= 1 / FPS + 0.05, `${duration(fb).toFixed(3)} s`);
  const titleDiff = (() => {
    const a = fr.frames.get(10), b = fr.frames.get(Math.round((2 + B.lead + 0.5) * FPS));
    let s = 0;
    for (let i = 0; i < a.length; i += 7) s += Math.abs(a[i] - b[i]);
    return s / (a.length / 7);
  })();
  check('the title page is there (differs from the roll)', titleDiff > 8, titleDiff.toFixed(1));
  check('watermark top right in B, not in A there', bright(fr.frames.get(bMid), B.width, B.wm) > 0.015 && bright(frames.get(mid), W, B.wm) < 0.005, `${(bright(fr.frames.get(bMid), B.width, B.wm) * 100).toFixed(1)}% vs ${(bright(frames.get(mid), W, B.wm) * 100).toFixed(2)}%`);
  if (keep) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(2 + B.lead + 2), '-i', fb, '-frames:v', '1', join(dir, 'pip.png')]);

  // C: the look with every effect (for the eyes; 3 s)
  if (keep) {
    await page.evaluate((o) => window.runExport('c.mp4', o), { ...base, watermark: {}, patch: { range: 'custom', customStart: 4.5, customEnd: 7.5 } });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(1 + 2.05), '-i', join(dir, 'c.mp4'), '-frames:v', '1', join(dir, 'effects.png')]);
  }
} finally {
  await browser.close();
  await server.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
