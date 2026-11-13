/**
 * Hands video, the whole way through the app, on a production build served with the netlify.toml
 * headers (CSP included) by tests/e2e/isolation.server.py:
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/handcam.mjs --dist /tmp/p2v-dist [--out SHOTS_DIR] [--port 5388] [--keep DIR] [--quick]
 *   (--quick: no export, only the import, the setup, the screenshots and the sync checks)
 *
 * 1. A synthetic "hands video" (tests/e2e/handcam-video.mjs: tilted 88-key keyboard, H.264 + AAC, VFR with
 *    a dropped frame, rotation metadata; a key turns green while its tone sounds) is imported with
 *    "Import a video of you playing": the notes come from its sound (>= 80 % found).
 * 2. Export video > Hands video > Set up: the corners are dragged onto the keyboard (known positions),
 *    88 keys, Save. Watermark on. Export "At the bottom", 720p30 MP4, sound "Your playing"; one export is
 *    canceled first (the next one runs).
 * 3. The file is decoded (ffmpeg): the lit keys sit on their notes' lanes (< 0.25 white key); every tone
 *    is at its note time and every camera frame is on the right output frame (sound and picture within
 *    one frame); the watermark is drawn under the video; the length is lead-in + song + tail.
 * 4. "Add a hands video" to an existing song, with the same video starting 2.345 s later: the automatic
 *    sync finds it within 20 ms, against the song's recording (Change video on the imported song) and
 *    against the notes only (a MIDI song).
 * Screenshots (deviceScaleFactor 2) go to --out. Exits 1 on a failure. Requires ffmpeg.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHandsVideo, makeNotes, sourceFrameTimes, toneOnset, QUAD } from './handcam-video.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const dist = opt('dist');
const out = opt('out');
const keepDir = opt('keep');
const port = Number(opt('port', '5388'));
const quick = args.includes('--quick');
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/handcam.mjs --dist DIR [--out DIR] [--keep DIR]');
  process.exit(2);
}
if (out) fs.mkdirSync(out, { recursive: true });
const dir = keepDir ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'handcam-ui-'));
fs.mkdirSync(dir, { recursive: true });

let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
};
const log = (...a) => console.log('  ', ...a);

const SECONDS = 12;
const SHIFT = 2.345;
const FPS = 30;
const SR = 48000;
const notes = makeNotes(SECONDS);
const videoA = path.join(dir, 'my-playing.mp4');
const videoB = path.join(dir, 'hands-later.mp4');
await makeHandsVideo({ out: videoA, notes, seconds: SECONDS });
await makeHandsVideo({ out: videoB, notes, seconds: SECONDS + SHIFT, shift: SHIFT });
const midiFile = path.join(dir, 'same-notes.mid');
fs.writeFileSync(midiFile, writeMidi(notes));
log(`videos: ${(fs.statSync(videoA).size / 1024).toFixed(0)} KB, ${(fs.statSync(videoB).size / 1024).toFixed(0)} KB; ${notes.length} notes`);

/** A format-0 MIDI file (120 BPM, 960 ticks per beat: 1 tick ≈ 0.52 ms). */
function writeMidi(ns) {
  const TPB = 960;
  const tick = (s) => Math.round((s / 0.5) * TPB);
  const ev = [];
  for (const n of ns) {
    ev.push({ t: tick(n.start), d: [0x90, n.midi, Math.max(1, Math.round(n.vel * 127))] });
    ev.push({ t: tick(n.start + n.dur), d: [0x80, n.midi, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.d[0] - b.d[0]);
  const vlq = (v) => {
    const b = [v & 0x7f];
    while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80);
    return b;
  };
  const trk = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20];
  let last = 0;
  for (const e of ev) {
    trk.push(...vlq(e.t - last), ...e.d);
    last = e.t;
  }
  trk.push(0, 0xff, 0x2f, 0);
  const hdr = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TPB >> 8, TPB & 0xff]);
  const th = Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0]);
  th.writeUInt32BE(trk.length, 4);
  return Buffer.concat([hdr, th, Buffer.from(trk)]);
}

// ---------- decoding helpers (ffmpeg) ----------
function rgbFrames(file, W, H, want) {
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
const probeDuration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
const probeSize = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
const onsetNear = (x, t) => toneOnset(x, SR, t);
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

// the app's own geometry code (the same modules the export uses), loaded in Node through Vite
const { createServer } = await import('vite');
const vite = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
const calib = await vite.ssrLoadModule('/src/lib/handcam/calibration.ts');
const wmLayout = await vite.ssrLoadModule('/src/lib/watermark/layout.ts');

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

const readSong = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('pianovision');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const q = r.result.transaction('songs', 'readonly').objectStore('songs').get(id);
          q.onsuccess = () => {
            const s = q.result;
            r.result.close();
            res(s ? { id: s.id, duration: s.duration, hasAudio: s.hasAudio, handVideo: s.handVideo ?? null, notes: s.arrangements.hard.notes.map((n) => ({ midi: n.midi, start: n.start })) } : null);
          };
          q.onerror = () => rej(q.error);
        };
      }),
    id,
  );
const shot = async (page, name, locator) => {
  if (!out) return;
  await page.waitForTimeout(400);
  if (locator) await locator.screenshot({ path: path.join(out, name) });
  else await page.screenshot({ path: path.join(out, name) });
};
const setRange = (locator, value) =>
  locator.evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

async function importVideoOfMe(page) {
  await page.goto(base + '/import?tab=audio');
  await page.getByTestId('hands-video-input').setInputFiles(videoA);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 600000 });
  return page.url().split('/studio/')[1];
}
async function openExport(page) {
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(600);
  await page.locator('button:has(svg.lucide-film)').first().click();
  const dlg = page.getByRole('dialog', { name: 'Export video' });
  await dlg.waitFor();
  return dlg;
}
const setup = (page) => page.getByTestId('hands-setup');
async function nextStep(page) {
  await setup(page).getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(250);
}
/** waits for the auto-sync result in the setup's Sync step */
async function waitSync(page) {
  await setup(page).getByTestId('sync-result').waitFor({ timeout: 300000 });
  return setup(page).getByTestId('sync-result').innerText();
}
/** waits for the Download button, printing the export's progress every 30 s */
async function waitExport(dlg, label) {
  const dl = dlg.getByRole('button', { name: /Download MP4/ });
  const t = Date.now();
  const timer = setInterval(async () => {
    const p = await dlg.locator('[aria-live=polite]').first().innerText().catch(() => '');
    log(`${label} ${((Date.now() - t) / 1000).toFixed(0)} s: ${p.replace(/\s+/g, ' ').slice(0, 120)}`);
  }, 30000);
  try {
    await dl.waitFor({ timeout: 1800000 });
  } finally {
    clearInterval(timer);
  }
  return dl;
}
/** closes the toasts (the one-time copyright note after the first export sits over the bottom-right buttons) */
async function dismissToasts(page) {
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 2000 }).catch(() => {});
}
async function saveSetup(page) {
  await dismissToasts(page);
  // through every step to the last one's Save (an earlier step's Save keeps only what was set up before)
  for (let i = 0; i < 6; i++) {
    const save = setup(page).getByTestId('hands-save');
    if (await save.isVisible().catch(() => false)) break;
    await nextStep(page);
  }
  await setup(page).getByTestId('hands-save').click();
  await setup(page).waitFor({ state: 'detached' });
  await page.waitForTimeout(1200); // the Studio saves the song after 600 ms
}

let page = null;
const errors = [];
try {
  // reduced motion: headless Chromium draws with a software GPU, and endless CSS animations (e.g. the Studio's pulsing
  // sound-loading icon) under the dialog's blurred backdrop keep it so busy that reading a
  // frame back (the setup screen's pictures) takes many seconds
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true, reducedMotion: 'reduce' });
  // the longest the page was frozen (ms): a timer that should fire every 100 ms
  await ctx.addInitScript(() => {
    window.__lag = 0;
    let last = performance.now();
    setInterval(() => {
      const n = performance.now();
      window.__lag = Math.max(window.__lag, n - last - 100);
      last = n;
    }, 100);
  });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    errors.push(m.text());
    log('console error:', m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // ---------------- 1. import a video of me playing ----------------
  const t0 = Date.now();
  const songId = await importVideoOfMe(page);
  let song = await readSong(page, songId);
  log(`imported in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${song.notes.length} notes, handVideo ${JSON.stringify({ store: song.handVideo?.store, offset: song.handVideo?.offset, rotation: song.handVideo?.rotation, w: song.handVideo?.displayW, h: song.handVideo?.displayH })}`);
  const found = notes.filter((n) => song.notes.some((m) => m.midi === n.midi && Math.abs(m.start - n.start) < 0.06)).length;
  check('import: notes come from the video’s sound (>= 80 % found)', found >= 0.8 * notes.length, `${found}/${notes.length}`);
  check('import: the video is kept with the song (its recording, stored once)', song.handVideo?.store === 'audio' && song.hasAudio && song.handVideo.rotation === 90 && song.handVideo.displayW === 640, '');
  const off1 = song.handVideo?.offset ?? 0;
  check('import: the video’s timeline is measured against the song’s (|offset| < 0.1 s)', Math.abs(off1) < 0.1, `${(off1 * 1000).toFixed(1)} ms`);

  // ---------------- 2. set up the keyboard ----------------
  let dlg = await openExport(page);
  const hs = dlg.getByTestId('hands-section');
  await hs.scrollIntoViewIfNeeded();
  await hs.getByTestId('hands-setup-open').click();
  await setup(page).waitFor();
  check('setup: an imported video is already in sync', /already in sync/.test(await setup(page).getByTestId('sync-step').innerText()));
  await nextStep(page); // pick a frame
  await setup(page).getByRole('img', { name: 'The frame used to set up the keyboard' }).waitFor({ timeout: 120000 });
  await nextStep(page); // corners
  const qe = setup(page).getByTestId('quad-editor').locator('canvas').first();
  await qe.waitFor({ timeout: 30000 });
  await page.waitForTimeout(800); // auto-detection runs once
  const dragCorners = async () => {
    const box = await qe.boundingBox();
    for (let i = 0; i < 4; i++) {
      const h = setup(page).locator(`button[data-corner="${i}"]`);
      const hb = await h.boundingBox();
      const [tx, ty] = [box.x + QUAD[i][0] * box.width, box.y + QUAD[i][1] * box.height];
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move((hb.x + hb.width / 2 + tx) / 2, (hb.y + hb.height / 2 + ty) / 2, { steps: 4 });
      await page.mouse.move(tx, ty, { steps: 4 });
      await page.mouse.up();
    }
  };
  await dragCorners();
  // the phone view of this step
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await shot(page, 'calibrate-corners-phone.png');
  const phoneWide = await page.evaluate(() => document.documentElement.scrollWidth);
  check('setup on a phone (390 px): nothing wider than the screen', phoneWide <= 391, `${phoneWide}px`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await dragCorners(); // again at the desktop size (finer)
  await nextStep(page); // keys
  await setup(page).getByRole('radio', { name: /88 keys/ }).click();
  await page.waitForTimeout(600);
  await shot(page, 'calibrate-keys-desktop.png');
  await saveSetup(page);
  song = await readSong(page, songId);
  const cal = song.handVideo?.calibration;
  const cornerErr = cal ? Math.max(...cal.corners.map((c, i) => Math.hypot(c[0] - QUAD[i][0], c[1] - QUAD[i][1]))) : Infinity;
  check('setup saved on the song (corners where dragged, 88 keys)', !!cal && cal.lo === 21 && cal.hi === 108 && cornerErr < 0.006, cal ? `corner error ${(cornerErr * 100).toFixed(2)} %` : 'none');

  // ---------------- watermark + export settings ----------------
  dlg = page.getByRole('dialog', { name: 'Export video' });
  const ws = dlg.getByTestId('watermark-section');
  await ws.scrollIntoViewIfNeeded();
  await ws.getByRole('switch', { name: 'Add your watermark' }).click();
  await ws.getByLabel('Watermark text').fill('youtube.com/yourname');
  await shot(page, 'watermark-settings.png', ws);
  await dlg.getByLabel('Resolution').selectOption('720');
  await dlg.getByLabel('Frame rate').selectOption('30');
  await dlg.getByLabel('Container').selectOption('mp4');
  await dlg.getByLabel('Quality').selectOption('standard');
  await hs.getByRole('radio', { name: 'At the bottom' }).click();
  await hs.getByRole('switch', { name: 'Light up the keys in the video' }).click(); // off: the lit keys are measured as filmed
  await hs.getByRole('switch', { name: 'Sparkles' }).click();
  await dlg.getByRole('radio', { name: 'Your playing', exact: true }).click();
  await setRange(dlg.getByLabel('Fade in'), 0);
  await setRange(dlg.getByLabel('Fade out'), 0);
  await setRange(dlg.getByLabel('Preview position'), 0.45);
  await hs.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await shot(page, 'export-dialog-handcam.png');

  // --quick: the setup, the screenshots and the sync checks only (no export)
  if (!quick) {
    // a canceled export, then the real one
    const render = dlg.getByRole('button', { name: 'Render video' });
    await render.click();
    await dlg.getByText('Drawing frames (decoding your video)').waitFor({ timeout: 240000 });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await render.waitFor({ timeout: 60000 });
    check('cancel stops the export (Render is back)', await render.isEnabled());
    const tExp = Date.now();
    await dismissToasts(page);
    await render.click();
    const dl = await waitExport(dlg, 'export');
    const [download] = await Promise.all([page.waitForEvent('download'), dl.click()]);
    const fileA = path.join(dir, 'export-bottom.mp4');
    await download.saveAs(fileA);
    log(`export: ${((Date.now() - tExp) / 1000).toFixed(0)} s, ${(fs.statSync(fileA).size / 1e6).toFixed(2)} MB`);

    // ---------------- 3. check the file ----------------
    {
      const [W, H] = probeSize(fileA);
      const lead = 2;
      const wm = { ...(await page.evaluate(() => JSON.parse(localStorage.getItem('piano2vision-watermark') ?? '{}').state ?? null)) };
      const band = wmLayout.watermarkBand({ ...wm, enabled: true, text: 'youtube.com/yourname', logo: null }, W, H);
      const songSpan = calib.noteSpan(song.notes);
      const g = calib.outputGeometry(W, H, cal, { wmBand: band, song: songSpan });
      const L = calib.calibratedLayout(cal, g);
      const lane = (m) => L.keys[m].x + L.keys[m].w / 2;
      const whiteW = L.whiteW;
      const rowFor = (m) => Math.round(g.yTop + ([1, 3, 6, 8, 10].includes(m % 12) ? 0.4 : 0.8) * g.kh);
      const off = off1;
      // output time of a song time (full song from 0, sound = the recording)
      const outT = (songT) => lead + songT;
      const wanted = new Set();
      const mid = Math.round(outT(5) * FPS);
      wanted.add(mid);
      for (const n of notes) for (let k = -10; k <= 14; k++) wanted.add(Math.round(outT(n.start - off) * FPS) + k);
      const { frames, count } = await rgbFrames(fileA, W, H, (i) => wanted.has(i));
      const audio = pcm(fileA);
      // (a) lanes
      const errs = notes.map((n) => {
        const fi = Math.round(outT(n.start - off + 0.15) * FPS);
        const x = frames.has(fi) ? green(frames.get(fi), W, rowFor(n.midi)) : null;
        return x === null ? Infinity : Math.abs(x - lane(n.midi)) / whiteW;
      });
      check('lanes line up with the real keys (< 0.25 white key)', Math.max(...errs) < 0.25, `worst ${Math.max(...errs).toFixed(3)}, mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(3)} white key`);
      // (b) sound and picture
      const src = sourceFrameTimes({ seconds: SECONDS, fps: 30 });
      const shownAt = (tv) => {
        let k = -1;
        for (let j = 0; j < src.length && src[j] <= tv + 1e-6; j++) k = j;
        return k < 0 ? null : src[k];
      };
      const toneErr = [];
      const picErr = [];
      for (const n of notes) {
        const exp = outT(n.start - off);
        const on = onsetNear(audio, exp);
        toneErr.push(on === null ? Infinity : on - exp);
        let want = null;
        let first = null;
        for (let fi = Math.round((exp - 0.25) * FPS); fi < (exp + 0.3) * FPS; fi++) {
          const ts = shownAt(fi / FPS - lead + off);
          if (want === null && ts !== null && ts >= n.start && ts < n.start + n.dur) want = fi;
          if (first === null && frames.has(fi) && green(frames.get(fi), W, rowFor(n.midi), lane(n.midi) - whiteW, lane(n.midi) + whiteW) !== null) first = fi;
        }
        picErr.push(want === null || first === null ? Infinity : first - want);
      }
      check('sound: every tone at its note time (< 3 ms)', toneErr.every((e) => Math.abs(e) < 0.003), toneErr.map((e) => (e * 1000).toFixed(1)).join(' ') + ' ms');
      check('picture: every camera frame on its output frame (sound and picture within one frame)', picErr.every((e) => Math.abs(e) <= 1), picErr.join(' '));
      // (c) the watermark under the video band: text pixels in the middle of the band, none at its left end
      const f = frames.get(mid);
      const brightShare = (xa, xb) => {
        let lit = 0;
        let all = 0;
        for (let y = Math.ceil(g.yTop + g.bandH + 1); y < H; y++)
          for (let x = Math.round(xa); x < xb; x++) {
            const i = (y * W + x) * 3;
            if (f[i] + f[i + 1] + f[i + 2] > 3 * 110) lit++;
            all++;
          }
        return lit / Math.max(1, all);
      };
      const inText = brightShare(W * 0.25, W * 0.75);
      const outside = brightShare(0, W * 0.1);
      check('watermark drawn in its band under the video', band > 0 && inText > 0.003 && outside < 0.0005, `${(inText * 100).toFixed(2)}% bright pixels in the middle, ${(outside * 100).toFixed(2)}% at the left, band ${band}px`);
      // (d) length
      const tail = 1.5;
      const d = probeDuration(fileA);
      check('length = lead-in + song + tail (within one frame)', Math.abs(d - (lead + song.duration + tail)) <= 1 / FPS + 0.03 && Math.abs(count - Math.ceil((lead + song.duration + tail) * FPS)) <= 1, `${d.toFixed(3)} s, ${count} frames, song ${song.duration.toFixed(3)} s`);
      if (out) execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(outT(5.3)), '-i', fileA, '-frames:v', '1', path.join(out, 'export-measure-frame.png')]);
    }

    // a short good-looking export (every effect on) for the eyes
    if (out) {
      await dismissToasts(page);
      await dlg.getByRole('button', { name: 'Back to settings' }).click();
      await hs.getByRole('switch', { name: 'Light up the keys in the video' }).click();
      await hs.getByRole('switch', { name: 'Sparkles' }).click();
      await dlg.getByRole('radio', { name: 'Custom' }).click();
      await setRange(dlg.getByLabel('Start', { exact: true }).first(), 4);
      await setRange(dlg.getByLabel('End', { exact: true }).first(), 7.5);
      await dlg.getByLabel('Resolution').selectOption('1080');
      await dismissToasts(page);
      await dlg.getByRole('button', { name: 'Render video' }).click();
      const dl2 = await waitExport(dlg, 'export (look)');
      const [d2] = await Promise.all([page.waitForEvent('download'), dl2.click()]);
      const fileC = path.join(dir, 'export-look.mp4');
      await d2.saveAs(fileC);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '3.62', '-i', fileC, '-frames:v', '1', path.join(out, 'export-frame.png')]);
      fs.rmSync(fileC, { force: true });
      await dismissToasts(page);
      await dlg.getByRole('button', { name: 'Back to settings' }).click();
      await dlg.getByRole('radio', { name: 'Full song' }).click();
    }
  }

  // ---------------- 4a. add a video that starts later: sync against the song's recording ----------------
  {
    await hs.scrollIntoViewIfNeeded();
    await page.evaluate(() => (window.__lag = 0));
    await hs.getByTestId('hands-video-file').setInputFiles(videoB);
    await setup(page).waitFor({ timeout: 60000 });
    const txt = await waitSync(page);
    const lag = await page.evaluate(() => window.__lag);
    check('add a hands video: the page stays responsive while it opens and syncs (longest freeze < 3 s)', lag < 3000, `${Math.round(lag)} ms`);
    await page.waitForTimeout(1200);
    await shot(page, 'sync-desktop.png');
    await saveSetup(page);
    const s2 = await readSong(page, songId);
    const want = off1 + SHIFT;
    const err = (s2.handVideo?.offset ?? NaN) - want;
    check('add a hands video: sync against the song’s recording (within 20 ms)', s2.handVideo?.store === 'handcam' && s2.handVideo.sync?.method === 'original' && Math.abs(err) <= 0.02, `found ${s2.handVideo?.offset?.toFixed(4)} s, want ${want.toFixed(4)} (error ${(err * 1000).toFixed(1)} ms), match ${s2.handVideo?.sync?.level}; “${txt.replace(/\s+/g, ' ')}”`);
    check('the keyboard setup is kept for a video of the same size', !!s2.handVideo?.calibration);
    await dlg.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  }

  // ---------------- 4b. a MIDI song (no recording): sync against the notes ----------------
  {
    await page.goto(base + '/import?tab=audio');
    await page.locator('input[type=file]:not([data-testid])').first().setInputFiles(midiFile);
    await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 120000 });
    const id = page.url().split('/studio/')[1];
    const d2 = await openExport(page);
    const hs2 = d2.getByTestId('hands-section');
    await hs2.scrollIntoViewIfNeeded();
    await hs2.getByTestId('hands-video-file').setInputFiles(videoB);
    await setup(page).waitFor({ timeout: 60000 });
    const txt = await waitSync(page);
    await saveSetup(page);
    const s3 = await readSong(page, id);
    const first = Math.min(...s3.notes.map((n) => n.start));
    // the MIDI song keeps the file's times (first note at notes[0].start)
    const want = SHIFT + (notes[0].start - first);
    const err = (s3.handVideo?.offset ?? NaN) - want;
    check('add a hands video: sync against the notes (within 20 ms)', s3.handVideo?.sync?.method === 'notes' && Math.abs(err) <= 0.02, `found ${s3.handVideo?.offset?.toFixed(4)} s, want ${want.toFixed(4)} (error ${(err * 1000).toFixed(1)} ms), match ${s3.handVideo?.sync?.level}; “${txt.replace(/\s+/g, ' ')}”`);
  }
  const bad = errors.filter((e) => !/Failed to load resource.*404|favicon/i.test(e));
  check('no console errors (CSP, workers, WebGL)', bad.length === 0, bad.slice(0, 5).join(' | '));
  await ctx.close();
} catch (e) {
  failures++;
  console.log('FAIL', e?.stack ?? e);
  if (errors.length) console.log('   console errors:', errors.slice(0, 8).join(' | '));
  await page?.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
  await vite.close();
  if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
