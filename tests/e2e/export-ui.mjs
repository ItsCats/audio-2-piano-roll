/**
 * Video export through the Studio's Export video dialog, against a production build served with the
 * netlify.toml headers by tests/e2e/isolation.server.py.
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/export-ui.mjs --dist /tmp/p2v-dist [--port 5392]
 *
 * Chromium runs with its graphics on the GPU (SwiftShader, a software GPU: --use-angle=swiftshader),
 * so the frames the export draws are GPU images the video encoder has to read back, as on a computer
 * with a graphics card. Plain headless Chromium draws everything in memory and would not show the
 * problem this guards against: the dialog's blurred backdrop was drawn again on every frame of the
 * progress spinner, and the encoder's frame reads waited behind it. The export stopped at frame 1
 * ("Saving the video got stuck") after 2 minutes.
 *
 * Checks, for a synthetic 10 s MIDI song (no hands video):
 *  - the page behind the dialog is dimmed, not blurred;
 *  - 720p 30 fps MP4: the frame counter keeps moving (no 45 s without progress) and the file has
 *    every frame;
 *  - 720p 30 fps WebM with a title page: the same, VP9.
 * (Headless Chromium never puts a page in the background, so a hidden tab is not tested here: the
 * export loop waits only on the encoders and decoders, never on requestAnimationFrame.)
 * Exits 1 on a failure. Requires ffprobe.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const dist = opt('dist');
const port = Number(opt('port', '5392'));
if (!dist) {
  console.error('usage: node tests/e2e/export-ui.mjs --dist DIR [--port 5392]');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-export-ui-'));
const SONG = 10;
/** the longest time the frame counter may stand still (it moves every 15 frames) */
const MAX_GAP_S = 45;

let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
};

// a MIDI file: a broken chord, a note every 0.25 s
function midiFile(seconds) {
  const TPB = 960;
  const tick = (s) => Math.round((s / 0.5) * TPB);
  const ev = [];
  for (let s = 0.5; s < seconds - 0.5; s += 0.25) {
    const m = 48 + [0, 4, 7, 12, 16, 19, 24][Math.round(s * 4) % 7];
    ev.push({ t: tick(s), d: [0x90, m, 90] }, { t: tick(s + 0.2), d: [0x80, m, 0] });
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
  const th = Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0]);
  th.writeUInt32BE(trk.length, 4);
  return Buffer.concat([Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, TPB >> 8, TPB & 0xff]), th, Buffer.from(trk)]);
}
const midi = path.join(tmp, 'broken-chords.mid');
fs.writeFileSync(midi, midiFile(SONG));

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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

/** frame counts the dialog showed, over time; and how the export ended */
async function render(dlg) {
  const t0 = performance.now();
  await dlg.getByRole('button', { name: 'Render video' }).click();
  const seen = [];
  let end = 'timeout';
  while (performance.now() - t0 < 600_000) {
    await new Promise((r) => setTimeout(r, 1000));
    const t = (performance.now() - t0) / 1000;
    if (await dlg.getByRole('button', { name: /^Download/ }).count()) {
      end = 'done';
      break;
    }
    const text = await dlg
      .locator('[aria-live=polite]')
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => '');
    const m = text.match(/frame (\d+)\/(\d+)/);
    if (m && (!seen.length || seen.at(-1).frame !== +m[1])) seen.push({ t, frame: +m[1], total: +m[2] });
    const err = await dlg
      .getByText(/stuck|failed|cannot/i)
      .first()
      .innerText({ timeout: 200 })
      .catch(() => '');
    if (err) {
      end = 'error: ' + err.slice(0, 160);
      break;
    }
    // the counter has not moved for too long: report it now instead of waiting for the 2 min stall guard
    if (seen.length && t - seen.at(-1).t > MAX_GAP_S + 5) {
      end = `no progress after frame ${seen.at(-1).frame}`;
      break;
    }
  }
  const total = (performance.now() - t0) / 1000;
  let gap = 0;
  for (let i = 1; i < seen.length; i++) gap = Math.max(gap, seen[i].t - seen[i - 1].t);
  if (seen.length) gap = Math.max(gap, seen[0].t, end === 'done' ? 0 : total - seen.at(-1).t); // the sound comes first, then frame 1
  return { end, total, seen, gap };
}

async function saveAndProbe(dlg, name) {
  const [d] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /^Download/ }).click()]);
  const file = path.join(tmp, name);
  await d.saveAs(file);
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', file]).toString();
  fs.rmSync(file, { force: true });
  // the "first export" notice would cover the dialog's buttons
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 2000 }).catch(() => {});
  return JSON.parse(out).streams[0];
}

const framesShown = async (dlg) => Number(((await dlg.locator('p.font-mono').first().innerText()).match(/([\d,]+) frames/)?.[1] ?? '0').replace(/,/g, ''));

try {
  await page.goto(base + '/import?tab=audio');
  await page.locator('input[type=file]:not([data-testid])').first().setInputFiles(midi);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 120000 });
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);
  await page.locator('button:has(svg.lucide-film)').first().click();
  const dlg = page.getByRole('dialog', { name: 'Export video' });
  await dlg.waitFor();
  const backdrop = await dlg.evaluate((el) => getComputedStyle(el.parentElement).backdropFilter);
  check('the page behind the Export dialog is dimmed, not blurred', backdrop === 'none', backdrop);

  // 1. 720p 30 fps MP4, tab in front
  await dlg.getByLabel('Resolution').selectOption({ label: '720p' });
  await dlg.getByLabel('Frame rate').selectOption({ label: '30 FPS' });
  await dlg.getByLabel('Container').selectOption({ label: 'MP4' });
  const want1 = await framesShown(dlg);
  const r1 = await render(dlg);
  console.log(`   MP4: ${r1.end} in ${r1.total.toFixed(0)} s; frames over time: ${r1.seen.map((s) => `${s.t.toFixed(0)}s:${s.frame}`).join(' ')}`);
  check('MP4 export finishes', r1.end === 'done', r1.end);
  check(`MP4: the frame counter never stands still for ${MAX_GAP_S} s`, r1.seen.length > 2 && r1.gap < MAX_GAP_S, `longest wait ${r1.gap.toFixed(1)} s`);
  if (r1.end === 'done') {
    const p = await saveAndProbe(dlg, 'a.mp4');
    check('MP4 file: H.264 1280×720 with every frame', p.codec_name === 'h264' && p.width === 1280 && p.height === 720 && Number(p.nb_read_frames) === want1, `${p.codec_name} ${p.width}×${p.height} ${p.nb_read_frames}/${want1} frames`);
    await dlg.getByRole('button', { name: 'Back to settings' }).click();
  }

  // 2. WebM with a title page
  await dlg.getByLabel('Container').selectOption({ label: 'WebM' });
  await dlg.getByRole('switch', { name: 'Add a title page' }).click();
  await page.waitForTimeout(500);
  const want2 = await framesShown(dlg);
  const r2 = await render(dlg);
  console.log(`   WebM: ${r2.end} in ${r2.total.toFixed(0)} s; frames over time: ${r2.seen.map((s) => `${s.t.toFixed(0)}s:${s.frame}`).join(' ')}`);
  check('WebM export with a title page finishes', r2.end === 'done', r2.end);
  check(`WebM: the frame counter never stands still for ${MAX_GAP_S} s`, r2.seen.length > 2 && r2.gap < MAX_GAP_S, `longest wait ${r2.gap.toFixed(1)} s`);
  if (r2.end === 'done') {
    const p = await saveAndProbe(dlg, 'b.webm');
    check('WebM file: VP9 with every frame (title page included)', p.codec_name === 'vp9' && Number(p.nb_read_frames) === want2, `${p.codec_name} ${p.nb_read_frames}/${want2} frames`);
  }
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('test ran', false, e.message.slice(0, 300));
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
