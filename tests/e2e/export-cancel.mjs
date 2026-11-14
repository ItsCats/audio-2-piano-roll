/**
 * Cancelling a video export, closing the Export video sheet and opening it again: the dialog must come
 * back usable at once, and a finished video must stay downloadable. Against a production build served
 * with the netlify.toml headers by tests/e2e/isolation.server.py.
 *
 *   npx vite build --outDir /tmp/p2v-dist
 *   node tests/e2e/export-cancel.mjs --dist /tmp/p2v-dist [--port 6150] [--only desktop,iphone,iphone-fallback,desktop-fallback] [--song 40]
 *
 * Every song is synthetic (MIDI broken chords; the "original recording" is a WAV of sine tones), with a
 * text watermark on. For a computer and an iPhone 14 (Chromium's emulation), with WebCodecs:
 *  - Cancel while preparing, during the title page frames, and mid-render with the original + piano:
 *    Render video is back within LIMIT_S, the sheet says the export was canceled, and no file of the
 *    cancelled export stays in the browser's private storage (OPFS). The 40 s song makes the WASM AAC
 *    encoder (headless Chromium has no native one) still busy with the whole song's sound during the
 *    title page: a cancel there used to keep "Stopping…" up for 6 s.
 *  - Closing the sheet mid-render (confirming), and opening it again: a clean, working dialog.
 *  - A finished video survives closing the sheet (X, Escape, a tap on the dimmed page) and "Back to
 *    settings": it used to be thrown away. Cancel is not offered while the file is written.
 *  - With a finished video kept, a new export is cancelled: the earlier video is still offered, and it
 *    downloads (a real download, checked with ffprobe).
 *  - After a reload, the startup clean-up leaves no export files behind.
 * Without WebCodecs' audio encoder (iPhone before iOS 26: the real-time MediaRecorder fallback), with a
 * WebKit-like rule that an audio context made outside the tap stays suspended: cancel mid-way, Render
 * is back at once, and the next export finishes (it never did when the context stayed suspended) and
 * downloads. The same on a computer without WebCodecs.
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
const port = Number(opt('port', '6150'));
const SONG = Number(opt('song', '40'));
const FALLBACK_SONG = 8;
const only = opt('only', '') ? opt('only').split(',') : null;
if (!dist) {
  console.error('usage: node tests/e2e/export-cancel.mjs --dist DIR [--port 6150] [--only desktop,iphone,iphone-fallback,desktop-fallback] [--song 40]');
  process.exit(2);
}
/** the longest Render video may stay off after a cancel (the dialog gives up waiting after 2 s) */
const LIMIT_S = 2.6;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-export-cancel-'));

let failures = 0;
const check = (name, ok, info = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
/** a synthetic "original recording": sine tones, 44.1 kHz stereo 16-bit WAV */
function wavFile(seconds) {
  const sr = 44100;
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = Math.round(Math.sin(2 * Math.PI * 220 * 2 ** ((Math.floor(t * 2) % 12) / 12) * t) * 8000);
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(v, 46 + i * 4);
  }
  return b;
}

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    await sleep(150);
  }
}
const { chromium, devices } = await import('playwright');
const browser = await chromium.launch();

/** WebKit-like: an audio context made (or resumed) outside the task of a tap stays suspended */
function strictAudioInit() {
  let inTap = false;
  for (const t of ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown'])
    addEventListener(
      t,
      () => {
        inTap = true;
        setTimeout(() => (inTap = false), 0);
      },
      true,
    );
  const Orig = window.AudioContext;
  window.__acLog = [];
  window.AudioContext = class extends Orig {
    constructor(...a) {
      super(...a);
      this.__locked = !inTap;
      window.__acLog.push({ locked: this.__locked });
      if (this.__locked) void super.suspend();
    }
    resume() {
      if (this.__locked && !inTap) return Promise.resolve();
      this.__locked = false;
      return super.resume();
    }
  };
}

async function runContext({ name, device, webcodecs, strictAudio, song }) {
  const ctxOpts = device === 'iphone' ? { ...devices['iPhone 14'], acceptDownloads: true } : { viewport: { width: 1400, height: 900 }, acceptDownloads: true };
  const context = await browser.newContext(ctxOpts);
  if (webcodecs === 'none')
    await context.addInitScript(() => {
      delete window.VideoEncoder;
      delete window.AudioEncoder;
      delete window.VideoDecoder;
      delete window.AudioDecoder;
    });
  if (webcodecs === 'noaudio')
    await context.addInitScript(() => {
      delete window.AudioEncoder;
      delete window.AudioDecoder;
    });
  if (strictAudio) await context.addInitScript(strictAudioInit);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept()); // "Stop the export in progress?" → OK
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)));
  const tag = (s) => `[${name}] ${s}`;
  const fallback = webcodecs !== 'full';

  // ---- a synthetic song with a synthetic original recording, a text watermark ----
  const midi = path.join(tmp, `${name}.mid`);
  fs.writeFileSync(midi, midiFile(song));
  await page.goto(base + '/import?tab=audio');
  await page.locator('input[type=file]:not([data-testid])').first().setInputFiles(midi);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 120000 });
  const songId = decodeURIComponent(page.url().split('/studio/')[1]);
  await page.evaluate(
    async ({ id, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'audio/wav' });
      await new Promise((res, rej) => {
        const r = indexedDB.open('pianovision');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['songs', 'audio'], 'readwrite');
          tx.objectStore('audio').put({ blob, name: 'tones.wav', type: 'audio/wav' }, id);
          const g = tx.objectStore('songs').get(id);
          g.onsuccess = () => tx.objectStore('songs').put({ ...g.result, hasAudio: true });
          tx.oncomplete = () => {
            db.close();
            res();
          };
          tx.onerror = () => rej(tx.error);
        };
        r.onerror = () => rej(r.error);
      });
      localStorage.setItem('piano2vision-watermark', JSON.stringify({ state: { enabled: true, text: 'Test Creator', spaced: true, font: 'cormorant', highlightName: true, size: 1, color: '#e8e8ee', opacity: 0.6, position: 'bc', onCards: true, logo: null }, version: 1 }));
      localStorage.setItem('piano2vision-export-notice-seen', '1');
    },
    { id: songId, b64: wavFile(song).toString('base64') },
  );
  await page.reload();
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);

  const dlg = page.getByRole('dialog', { name: 'Export video' });
  const openDialog = async () => {
    if (await dlg.count()) return;
    await page.locator('button:has(svg.lucide-film)').first().click();
    await dlg.waitFor();
    await page.waitForTimeout(300);
  };
  const renderBtn = () => dlg.locator('footer button').last();
  const ui = () =>
    page.evaluate(() => {
      const d = document.querySelector('[role=dialog][aria-label="Export video"]');
      if (!d) return { open: false };
      const btns = [...d.querySelectorAll('button')];
      const b = [...d.querySelectorAll('footer button')].at(-1);
      // the progress panel (with its percentage), not the notice
      const panel = [...d.querySelectorAll('[aria-live=polite]')].find((x) => !x.matches('[data-testid=export-notice]') && /\d+%/.test(x.textContent));
      return {
        open: true,
        render: b ? { text: b.textContent.trim(), disabled: b.disabled } : null,
        progress: panel ? panel.innerText.replace(/\s+/g, ' ').trim() : null,
        notice: d.querySelector('[data-testid=export-notice]')?.textContent.trim() ?? null,
        error: d.querySelector('p.text-bad')?.textContent.trim() ?? null,
        download: btns.some((x) => /^Download/.test(x.textContent.trim())),
        cancel: btns.some((x) => x.textContent.trim() === 'Cancel'),
      };
    });
  const opfs = () =>
    page.evaluate(async () => {
      try {
        const r = await navigator.storage.getDirectory();
        const out = [];
        for await (const n of r.keys()) if (n.startsWith('export-')) out.push(n);
        return out.sort();
      } catch {
        return [];
      }
    });
  const setup = async ({ preset = 'quick', sound = 'piano', title = false }) => {
    await openDialog();
    if (await dlg.getByRole('button', { name: 'Back to settings' }).count()) await dlg.getByRole('button', { name: 'Back to settings' }).click();
    await dlg.getByRole('button', { name: preset === 'youtube' ? /YouTube Ready/ : /Quick Preview/ }).click();
    const radio = dlg.getByRole('radiogroup', { name: 'Sound' });
    if (await radio.count()) await radio.getByRole('radio', { name: { piano: 'Piano', original: 'Original song', both: 'Both' }[sound], exact: true }).click();
    const sw = dlg.getByRole('switch', { name: 'Add a title page' });
    if (((await sw.getAttribute('aria-checked')) === 'true') !== title) await sw.click();
    await page.waitForTimeout(400);
  };
  /** presses Cancel (or the sheet's Close) from inside the page as soon as `when` holds; polled every 5 ms */
  const actWhen = (what, when) =>
    page.evaluate(
      ({ what, when }) =>
        new Promise((resolve) => {
          const t0 = performance.now();
          const tick = () => {
            const d = document.querySelector('[role=dialog][aria-label="Export video"]');
            const panel = d && [...d.querySelectorAll('[aria-live=polite]')].find((x) => !x.matches('[data-testid=export-notice]'));
            const txt = panel ? panel.innerText.replace(/\s+/g, ' ') : '';
            const pct = Number(/(\d+)%/.exec(txt)?.[1] ?? -1);
            const el = performance.now() - t0;
            const go = when.kind === 'immediate' || (when.kind === 'pct' && pct >= when.arg) || (when.kind === 'text' && txt.includes(when.arg));
            const btns = d ? [...d.querySelectorAll('button')] : [];
            if (btns.some((x) => /^Download/.test(x.textContent.trim()))) return resolve({ done: false, why: 'finished first', txt });
            if (el > 240000) return resolve({ done: false, why: 'timeout', txt });
            const target = what === 'cancel' ? btns.find((x) => x.textContent.trim() === 'Cancel') : d?.querySelector('button[aria-label=Close]');
            if (go && target) {
              target.click();
              return resolve({ done: true, at: Math.round(el), txt: txt.slice(0, 80) });
            }
            setTimeout(tick, 5);
          };
          tick();
        }),
      { what, when },
    );
  /** seconds until Render video is enabled again (null: not within 30 s) */
  const untilReady = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const s = await ui();
      if (s.open && s.render && !s.render.disabled && s.render.text === 'Render video') return (Date.now() - t0) / 1000;
      await sleep(50);
    }
    return null;
  };
  /** renders to the end; reports whether Cancel was ever offered while the file was written */
  const renderToEnd = async () => {
    await renderBtn().click();
    return page.evaluate(
      () =>
        new Promise((resolve) => {
          const t0 = performance.now();
          let finalizing = 0;
          let cancelWhileFinalizing = false;
          const tick = () => {
            const d = document.querySelector('[role=dialog][aria-label="Export video"]');
            const btns = d ? [...d.querySelectorAll('button')] : [];
            const txt = d?.innerText ?? '';
            if (/Finalizing file/.test(txt)) {
              finalizing++;
              if (btns.some((x) => x.textContent.trim() === 'Cancel')) cancelWhileFinalizing = true;
            }
            if (btns.some((x) => /^Download/.test(x.textContent.trim()))) return resolve({ ok: true, secs: (performance.now() - t0) / 1000, finalizing, cancelWhileFinalizing });
            const err = d?.querySelector('p.text-bad')?.textContent;
            if (err) return resolve({ ok: false, why: err, finalizing, cancelWhileFinalizing });
            if (performance.now() - t0 > 400000) return resolve({ ok: false, why: 'timeout', finalizing, cancelWhileFinalizing });
            setTimeout(tick, 5);
          };
          tick();
        }),
    );
  };
  const download = async (want) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), dlg.getByRole('button', { name: /^Download/ }).click()]);
    const file = path.join(tmp, `${name}-${Date.now()}.${want.ext}`);
    await d.saveAs(file);
    let probe;
    try {
      probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', file]).toString());
    } catch (e) {
      probe = { error: String(e.message).slice(0, 200) };
    }
    const size = fs.statSync(file).size;
    fs.rmSync(file, { force: true });
    const streams = (probe.streams ?? []).map((x) => `${x.codec_type}:${x.codec_name}`);
    const dur = Number(probe.format?.duration);
    const okStreams = streams.some((x) => x.startsWith('video:')) && streams.some((x) => x.startsWith('audio:'));
    const okDur = want.minDur === undefined || !(dur < want.minDur); // MediaRecorder WebM has no duration
    return { ok: !probe.error && size > 10000 && okStreams && okDur && d.suggestedFilename().endsWith('.' + want.ext), info: `${d.suggestedFilename()} ${(size / 1e6).toFixed(1)} MB ${streams.join(',')} ${Number.isFinite(dur) ? dur.toFixed(1) + ' s' : ''}` };
  };
  /** a cancel (or close + reopen) at `when`: Render back in time, a clean dialog, no file left */
  const cancelCase = async (label, settings, what, when) => {
    await setup(settings);
    const before = await opfs();
    await renderBtn().click();
    const act = await actWhen(what, when);
    if (!act.done) {
      check(tag(`${label}: the moment to ${what} was reached`), false, `${act.why} ${act.txt ?? ''}`);
      await untilReady();
      return;
    }
    if (what === 'close') {
      await sleep(200);
      check(tag(`${label}: the sheet closed`), (await dlg.count()) === 0);
      await openDialog();
    }
    const secs = await untilReady();
    const s = await ui();
    check(tag(`${label}: Render video is back within ${LIMIT_S} s`), secs !== null && secs <= LIMIT_S, `${secs === null ? 'never' : secs.toFixed(2) + ' s'} (${what} at ${act.at} ms: "${act.txt}")`);
    check(tag(`${label}: a clean dialog (no progress, no error) that says the export was canceled`), s.progress === null && !s.error && /Export canceled/.test(s.notice ?? ''), JSON.stringify(s));
    // the cancelled export's file is closed and removed (it may take a moment more than Render)
    let left = [];
    for (let i = 0; i < 40; i++) {
      left = (await opfs()).filter((n) => !before.includes(n));
      if (!left.length) break;
      await sleep(100);
    }
    check(tag(`${label}: no file of the cancelled export left in the browser’s storage`), left.length === 0, left.join(' '));
  };

  try {
    await openDialog();
    if (!fallback) {
      await cancelCase('cancel while preparing', { sound: 'piano' }, 'cancel', { kind: 'immediate' });
      await cancelCase('cancel during the title page frames', { sound: 'piano', title: true }, 'cancel', { kind: 'text', arg: 'frame ' });
      await cancelCase('cancel mid-render, original + piano, title page', { sound: 'both', title: true }, 'cancel', { kind: 'pct', arg: 40 });
      await cancelCase('close the sheet mid-render, open it again', { sound: 'piano', title: true }, 'close', { kind: 'pct', arg: 30 });

      // ---- a finished video survives closing the sheet ----
      await setup({ sound: 'both', title: true });
      const r = await renderToEnd();
      check(tag('the next export after the cancels finishes'), r.ok, r.ok ? `${r.secs.toFixed(0)} s` : r.why);
      check(tag('Cancel is not offered while the file is written'), !r.cancelWhileFinalizing, `"Finalizing file" seen in ${r.finalizing} polls`);
      if (r.ok) {
        const reopenKeeps = async (how, closeIt) => {
          await closeIt();
          await sleep(250);
          const closed = (await dlg.count()) === 0;
          await openDialog();
          const s = await ui();
          check(tag(`the finished video is still there after closing the sheet (${how}) and opening it again`), closed && s.download, JSON.stringify({ closed, ...s }));
        };
        await reopenKeeps('X', () => dlg.getByRole('button', { name: 'Close' }).click());
        await reopenKeeps('Escape', () => page.keyboard.press('Escape'));
        await reopenKeeps('a tap on the dimmed page', () => page.mouse.click(5, 5));
        await dlg.getByRole('button', { name: 'Back to settings' }).click();
        const s = await ui();
        check(tag('"Back to settings" keeps the video: the sheet offers it'), /last video is still here/.test(s.notice ?? '') && !s.download, JSON.stringify(s));
        await dlg.getByRole('button', { name: 'Show video' }).click();
        check(tag('"Show video" brings the Download button back'), (await ui()).download);
        await dlg.getByRole('button', { name: 'Back to settings' }).click();

        // ---- a new export is cancelled: the earlier video is still offered, and downloads ----
        await cancelCase('cancel a new export while a finished video is kept', { sound: 'both', title: true }, 'cancel', { kind: 'pct', arg: 30 });
        const s2 = await ui();
        check(tag('after that cancel the earlier video is still offered'), /last video is still here/.test(s2.notice ?? ''), s2.notice ?? '');
        await dlg.getByRole('button', { name: 'Show video' }).click();
        const dl = await download({ ext: 'mp4', minDur: song - 1 });
        check(tag('it downloads: a playable MP4 (video + audio, full length)'), dl.ok, dl.info);
      }
      // ---- the startup clean-up ----
      await page.reload();
      await page.locator('canvas').first().waitFor();
      await sleep(7000);
      const left = await opfs();
      check(tag('after a reload, the startup clean-up leaves no export files'), left.length === 0, left.join(' '));
    } else {
      await setup({ sound: 'piano', title: true });
      check(tag('the sheet says the video is recorded in real time'), await dlg.getByText(/recorded in real time/).count() > 0);
      await cancelCase('cancel the real-time recording mid-way', { sound: 'piano', title: true }, 'cancel', { kind: 'pct', arg: 30 });
      if (strictAudio) await page.evaluate(() => window.__acLog.splice(0));
      const r = await renderToEnd();
      check(tag('the next export finishes'), r.ok, r.ok ? `${r.secs.toFixed(0)} s` : r.why);
      if (strictAudio) {
        const log = await page.evaluate(() => window.__acLog.splice(0));
        check(tag('the recording’s audio context was made within the tap (not left suspended)'), log.length > 0 && log.every((x) => !x.locked), JSON.stringify(log));
      }
      if (r.ok) {
        const dl = await download({ ext: 'webm' });
        check(tag('it downloads: a WebM with video and audio'), dl.ok, dl.info);
      }
    }
    check(tag('no console errors'), errors.length === 0, errors.slice(0, 4).join(' | '));
  } catch (e) {
    check(tag('test ran'), false, e.message.slice(0, 400));
  } finally {
    await context.close();
  }
}

const contexts = [
  { name: 'desktop', device: 'desktop', webcodecs: 'full', song: SONG },
  { name: 'iphone', device: 'iphone', webcodecs: 'full', song: SONG },
  { name: 'iphone-fallback', device: 'iphone', webcodecs: 'noaudio', strictAudio: true, song: FALLBACK_SONG },
  { name: 'desktop-fallback', device: 'desktop', webcodecs: 'none', song: FALLBACK_SONG },
];
try {
  for (const c of contexts) if (!only || only.includes(c.name)) await runContext(c);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
