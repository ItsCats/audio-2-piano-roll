/**
 * Note length of the high-accuracy piano model ("as played": a note ends when its key is let go, the
 * sustain pedal heard in the recording keeps it ringing; music/noteLength.ts), in Playwright Chromium
 * on a PRODUCTION build served with the exact netlify.toml headers (tests/e2e/isolation.server.py).
 *
 *   npm run build
 *   TMPDIR=/dev/shm node tests/e2e/noteLength.mjs --dist dist [--port 6042] [--shots DIR] [--no-video]
 *
 * The recording is made here, with nothing copyrighted: a synthetic MIDI file (8 bars of pedalled
 * broken chords, every key held 0.12 s, the pedal changed every bar) is imported, and its Hard level is
 * exported as WAV by the app's own piano engine (the pedal rings every chord to the bar line). That
 * WAV is then imported with "Piano solo" + "High-accuracy piano model".
 *
 * Desktop 1280×800:
 *  - the song opens in the Studio with Note length "As played"; stored: noteLength 'played', the
 *    automatic pedal off, a pedal range per bar matching the MIDI pedal; Hard's notes are short (the
 *    model alone hears them ring to the bar line) and their onsets match the MIDI notes;
 *  - the MIDI export has the notes as played and the pedal (CC64);
 *  - playback keeps sounding through the pedal: the WAV export of Hard rings in the second half of
 *    each bar like the recording (and the same notes with "Sustain pedal" off do not);
 *  - "As heard" lengthens the notes (one undo step back in Edit mode, with the library picture; redo), is remembered after a reload, and back to "As played" gives exactly the same notes and pedal; the sheet
 *    (MusicXML export and the drawn sheet) and the video export follow the setting;
 * iPhone 14: the same import; the notes are short; the switch works and is remembered; no
 *   sideways scroll. Both: no console errors. Screenshots in --shots.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const dist = opt('dist');
const port = Number(opt('port', '6042'));
const withVideo = !args.includes('--no-video');
const shots = opt('shots', fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-notelength-')));
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node tests/e2e/noteLength.mjs --dist BUILD_DIR [--port N] [--shots DIR] [--no-video]');
  process.exit(2);
}
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-notelength-work-'));
const { chromium, devices } = await import('playwright');
const { Midi } = require('@tonejs/midi');

let failed = false;
const check = (name, ok, info) => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''}`);
};

// ---- the synthetic piece: 8 bars of 2 s, C Am F G twice
const BAR = 2;
const BARS = 8;
const LEAD = 0.5;
const CHORDS = [
  [48, 60, 64, 67, 72, 76],
  [45, 57, 60, 64, 69, 72],
  [41, 53, 57, 60, 65, 69],
  [43, 55, 59, 62, 67, 71],
];
const KEY_HELD = 0.12;
const STEP = 0.15;
function piece() {
  const notes = [];
  const pedal = [];
  for (let b = 0; b < BARS; b++) {
    const t0 = LEAD + b * BAR;
    CHORDS[b % 4].forEach((m, i) => notes.push({ midi: m, time: t0 + i * STEP, duration: KEY_HELD, velocity: 0.55 + 0.05 * (i % 3) }));
    pedal.push({ start: t0 + 0.05, end: t0 + BAR - 0.05 });
  }
  return { notes, pedal };
}
const truth = piece();
const midiFile = path.join(work, 'pedalled-chords.mid');
{
  const midi = new Midi();
  midi.header.setTempo(120);
  midi.header.update();
  const tr = midi.addTrack();
  for (const n of truth.notes) tr.addNote(n);
  for (const p of truth.pedal) {
    tr.addCC({ number: 64, value: 1, time: p.start });
    tr.addCC({ number: 64, value: 0, time: p.end });
  }
  fs.writeFileSync(midiFile, Buffer.from(midi.toArray()));
}

// ---- helpers
function readWav(file) {
  const b = fs.readFileSync(file);
  let o = 12;
  let fmt;
  let data;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4);
    const len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len & 1);
  }
  const frames = data.length / (fmt.channels * (fmt.bits / 8));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const at = (i * fmt.channels + c) * (fmt.bits / 8);
      s += fmt.format === 3 ? data.readFloatLE(at) : data.readInt16LE(at) / 32768;
    }
    mono[i] = s / fmt.channels;
  }
  return { rate: fmt.rate, mono };
}
const rms = (w, a, b) => {
  const i0 = Math.max(0, Math.round(a * w.rate));
  const i1 = Math.min(w.mono.length, Math.round(b * w.rate));
  let s = 0;
  for (let i = i0; i < i1; i++) s += w.mono[i] * w.mono[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};
/** RMS over the second half of every bar (no key is held there: only the pedal keeps the chord ringing) */
const tailRms = (w, offset = 0) => {
  let s = 0;
  for (let b = 0; b < BARS; b++) s += rms(w, offset + LEAD + b * BAR + 1.0, offset + LEAD + b * BAR + 1.8) ** 2;
  return Math.sqrt(s / BARS);
};
/** the audio's first sound (s): the exports start at the song's first note, the recording has a lead-in */
const firstSound = (w) => {
  const peak = w.mono.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const i = w.mono.findIndex((x) => Math.abs(x) > peak * 0.05);
  return i / w.rate;
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
};
/** mean number of notes of a hand held at once, over the time that hand holds any */
function heldAtOnce(notes, hand) {
  const ns = notes.filter((n) => n.hand === hand);
  let on = 0;
  let sum = 0;
  for (let t = 0; t < 30; t += 0.01) {
    const k = ns.filter((n) => n.start <= t && t < n.start + n.dur).length;
    if (k) {
      on++;
      sum += k;
    }
  }
  return on ? sum / on : 0;
}
/** pedal-down overlap (P, R) of two range lists, after aligning `est` by `shift` seconds */
function pedalPR(ref, est, shift) {
  const cov = (rs, t) => rs.some((p) => p.start <= t && t < p.end);
  let tp = 0;
  let e = 0;
  let r = 0;
  for (let t = 0; t < LEAD + BARS * BAR + 1; t += 0.01) {
    const a = cov(ref, t);
    const b = cov(est, t - shift);
    if (a && b) tp++;
    if (b) e++;
    if (a) r++;
  }
  return { P: +(tp / Math.max(1, e)).toFixed(2), R: +(tp / Math.max(1, r)).toFixed(2) };
}
/** total written length of the sounding notes (not rests) in a MusicXML file, in divisions per quarter */
function writtenLength(xml) {
  const div = Number(xml.match(/<divisions>(\d+)<\/divisions>/)?.[1] ?? 1);
  let sum = 0;
  for (const m of xml.matchAll(/<note\b[^>]*>([\s\S]*?)<\/note>/g)) {
    if (/<rest\b/.test(m[1]) || /<grace\b/.test(m[1])) continue;
    sum += Number(m[1].match(/<duration>(\d+)<\/duration>/)?.[1] ?? 0) / div;
  }
  return sum;
}
/** bright pixels (the falling notes) in the area above the keyboard of a video frame at `t` s */
function notePixels(video, t) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=320:180,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  let n = 0;
  // the top 60 % of the frame: the falling notes (the keyboard is at the bottom)
  for (let y = 0; y < 108; y++) for (let x = 0; x < 320; x++) if (raw[y * 320 + x] > 140) n++;
  return n;
}

const server = spawn('python3', [path.join(root, 'tests/e2e/isolation.server.py'), dist, path.join(root, 'netlify.toml'), String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    await fetch(base + '/');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function newPage(contextOpts) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...contextOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}
const songId = (page) => decodeURIComponent(new URL(page.url()).pathname.split('/').pop());
const getSong = (page) =>
  page.evaluate(
    (id) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('pianovision');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const g = r.result.transaction('songs').objectStore('songs').get(id);
          g.onsuccess = () => {
            res(g.result);
            r.result.close();
          };
          g.onerror = () => rej(g.error);
        };
      }),
    songId(page),
  );
/** the stored song once its scheduled save has landed (matching `pred`) */
async function storedSong(page, pred, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const s = await getSong(page);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) return s;
    await page.waitForTimeout(200);
  }
}
const sideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const exportMenu = (page) => page.locator('button[aria-haspopup="menu"]:has(svg.lucide-download)').first();
async function download(page, item, file) {
  await exportMenu(page).click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.getByRole('menuitem', { name: item }).click()]);
  await d.saveAs(file);
  // the "first export" notice would cover buttons
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 2000 }).catch(() => {});
  return file;
}
const difficulty = (page, d) => page.getByRole('radiogroup', { name: 'Difficulty' }).getByRole('radio', { name: d }).click();
async function openPanel(page, tab) {
  if (!(await page.getByRole('tablist').count())) await page.getByRole('button', { name: 'Show panel' }).first().click();
  await page.getByRole('tab', { name: tab }).click();
}
const noteLength = (page) => page.getByRole('radiogroup', { name: 'Note length' });
async function closePanelIfOverlay(page) {
  const close = page.getByRole('button', { name: 'Close panel' });
  if ((await close.count()) && (await close.isVisible())) await close.click();
}
async function importHighAccuracy(page, wav) {
  await page.goto(`${base}/import`);
  await page.getByRole('heading', { name: 'Import music', exact: true }).waitFor();
  await page.getByRole('radiogroup', { name: 'Detection preset' }).getByRole('radio', { name: 'Piano solo' }).click();
  const box = page.getByRole('checkbox', { name: /High-accuracy piano model/ });
  if (!(await box.isChecked())) await box.check();
  const t0 = Date.now();
  await page.locator('[role="button"] input[type="file"]').first().setInputFiles(wav);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 10 * 60000 });
  await page.locator('canvas').first().waitFor();
  return (Date.now() - t0) / 1000;
}
/** checks on a stored song made from the recording: short notes, the recorded pedal, onsets */
function checkPlayed(dev, song, shift) {
  const hard = song.arrangements.hard;
  check(`${dev}: stored as played (noteLength 'played', automatic pedal off)`, song.noteLength === 'played' && song.autoPedal === false, { noteLength: song.noteLength, autoPedal: song.autoPedal });
  const pr = pedalPR(truth.pedal, song.basePedal, shift);
  // (the pedal goes down after the keys the model heard stop, so it can start a little after the MIDI pedal: recall >= 0.75)
  check(`${dev}: a pedal range per bar, where the MIDI pedal is (overlap P >= 0.8, R >= 0.75)`, song.basePedal.length >= BARS - 1 && song.basePedal.length <= BARS + 2 && pr.P >= 0.8 && pr.R >= 0.75, { ranges: song.basePedal.length, ...pr });
  // Easy has no pedal: it is built from the notes as they ring (held, like before the note-length change)
  const easyDur = median(song.arrangements.easy.notes.map((n) => n.dur));
  check(`${dev}: Easy holds its notes (built from the notes as they ring; median >= 2x Hard's)`, easyDur >= 2 * median(hard.notes.map((n) => n.dur)), { easy: +easyDur.toFixed(3), hard: +median(hard.notes.map((n) => n.dur)).toFixed(3) });
  check(`${dev}: Medium and Hard play that pedal, Easy none`, JSON.stringify(hard.pedal) === JSON.stringify(song.basePedal) && JSON.stringify(song.arrangements.medium.pedal) === JSON.stringify(song.basePedal) && song.arrangements.easy.pedal.length === 0);
  // onsets: every MIDI note found within 50 ms
  const found = truth.notes.filter((t) => hard.notes.some((n) => n.midi === t.midi && Math.abs(n.start - (t.time - shift)) < 0.05)).length;
  check(`${dev}: onsets match the MIDI notes (recall >= 0.9)`, found / truth.notes.length >= 0.9, `${found}/${truth.notes.length}`);
  // the model alone hears them ring to the bar line (~1.2-1.9 s): as played they end at the next note
  const durs = hard.notes.filter((n) => n.hand === 'R').map((n) => n.dur);
  const medDur = median(durs);
  const held = heldAtOnce(hard.notes, 'R');
  check(`${dev}: right-hand notes are short (median <= 0.3 s; as heard ~1.2 s)`, medDur <= 0.3, { median: +medDur.toFixed(3) });
  check(`${dev}: right hand holds few notes at once (mean <= 2)`, held <= 2, { mean: +held.toFixed(2) });
  return { medDur, held };
}

try {
  // ======== desktop
  const { ctx, page, errors } = await newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  // 1. the recording: the synthetic MIDI's Hard level rendered by the app's piano engine (with its pedal)
  await page.goto(`${base}/import?tab=audio`);
  await page.locator('input[type=file]:not([data-testid])').first().setInputFiles(midiFile);
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 120000 });
  await page.locator('canvas').first().waitFor();
  await difficulty(page, 'Hard');
  const recording = await download(page, /^Audio WAV \(hard\)/, path.join(work, 'recording.wav'));
  const rec = readWav(recording);
  const recStart = firstSound(rec);
  console.log(`     recording: ${(rec.mono.length / rec.rate).toFixed(1)} s, first sound at ${recStart.toFixed(2)} s`);

  // 2. import it with the high-accuracy piano model
  const took = await importHighAccuracy(page, recording);
  console.log(`     high-accuracy import took ${took.toFixed(0)} s`);
  // the recording starts at the MIDI song's first note (0.5 s into the MIDI): times shift by that much
  const shift = LEAD - recStart;
  await difficulty(page, 'Hard');
  await openPanel(page, 'Notes');
  check('desktop: Note length shows "As played"', (await noteLength(page).getByRole('radio', { name: 'As played' }).getAttribute('aria-checked')) === 'true');
  const song = await getSong(page);
  const played = checkPlayed('desktop', song, shift);
  await page.screenshot({ path: path.join(shots, 'desktop-as-played-panel.png') });

  // 3. MIDI export: notes as played + CC64
  const midOut = await download(page, /^MIDI file \(hard\)/, path.join(work, 'hard.mid'));
  const mid = new Midi(fs.readFileSync(midOut));
  const midNotes = mid.tracks.flatMap((t) => t.notes);
  const cc = mid.tracks.flatMap((t) => t.controlChanges[64] ?? []);
  check('desktop: MIDI export has the pedal (CC64 down and up per range)', cc.filter((c) => c.value >= 0.5).length >= BARS - 1 && cc.filter((c) => c.value < 0.5).length >= BARS - 1, { cc64: cc.length });
  check('desktop: MIDI export has the notes as played', Math.abs(median(midNotes.map((n) => n.duration)) - median(song.arrangements.hard.notes.map((n) => n.dur))) < 0.02, { median: +median(midNotes.map((n) => n.duration)).toFixed(3) });

  // 4. playback keeps sounding through the pedal: WAV export (the app's offline render, the same engine as playback)
  const playedWav = readWav(await download(page, /^Audio WAV \(hard\)/, path.join(work, 'played.wav')));
  await openPanel(page, 'Sound');
  await page.getByRole('switch', { name: 'Sustain pedal' }).click();
  const dryWav = readWav(await download(page, /^Audio WAV \(hard\)/, path.join(work, 'nopedal.wav')));
  await page.getByRole('switch', { name: 'Sustain pedal' }).click();
  // the exports start at the song's first note; the recording at its first sound
  const recTail = tailRms(rec, recStart - LEAD);
  const songStart = Math.min(...song.arrangements.hard.notes.map((n) => n.start));
  const playedTail = tailRms(playedWav, firstSound(playedWav) - (songStart + shift));
  const dryTail = tailRms(dryWav, firstSound(dryWav) - (songStart + shift));
  const db = (x) => +(20 * Math.log10(x / recTail)).toFixed(1);
  check('desktop: as played + pedal rings through the second half of each bar like the recording (within 6 dB)', db(playedTail) > -6 && db(playedTail) < 6, { playedDb: db(playedTail) });
  check('desktop: (the same notes with the pedal off are clearly quieter there)', db(dryTail) < db(playedTail) - 3, { noPedalDb: db(dryTail) });

  // 5. the sheet, as played
  const xmlPlayed = fs.readFileSync(await download(page, /^MusicXML \(hard\)/, path.join(work, 'played.musicxml')), 'utf8');
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: /Sheet music/ }).click();
  await page.waitForTimeout(2500);
  await closePanelIfOverlay(page);
  await page.screenshot({ path: path.join(shots, 'desktop-sheet-as-played.png') });
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: /Piano roll/ }).click();
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'desktop-roll-as-played.png') });

  let videoPlayed;
  async function exportVideo(name) {
    await exportMenu(page).click();
    await page.getByRole('menuitem', { name: /^Video/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Export video' });
    await dlg.waitFor();
    await dlg.getByLabel('Resolution').selectOption({ label: '720p' });
    await dlg.getByLabel('Frame rate').selectOption({ label: '30 FPS' });
    await dlg.getByLabel('Container').selectOption({ label: 'MP4' });
    await dlg.getByRole('button', { name: 'Render video' }).click();
    await dlg.getByRole('button', { name: /^Download/ }).waitFor({ timeout: 600000 });
    const [d] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /^Download/ }).click()]);
    const file = path.join(work, name);
    await d.saveAs(file);
    for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) await b.click({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => dlg.getByRole('button', { name: /Close/ }).first().click());
    return file;
  }
  if (withVideo) videoPlayed = await exportVideo('played.mp4');

  // 6. As heard: longer notes, the same pedal; one undo step back; remembered after a reload
  await openPanel(page, 'Notes');
  await noteLength(page).getByRole('radio', { name: 'As heard' }).click();
  await page.getByText('Notes now last as long as they ring').waitFor({ timeout: 5000 });
  const heard = await storedSong(page, (s) => s.noteLength === 'heard');
  const heardDur = median(heard.arrangements.hard.notes.filter((n) => n.hand === 'R').map((n) => n.dur));
  check('desktop: As heard lengthens the notes (median >= 3x as played), keeps the pedal', heard.noteLength === 'heard' && heardDur >= 3 * played.medDur && JSON.stringify(heard.basePedal) === JSON.stringify(song.basePedal), { median: +heardDur.toFixed(3) });
  // (undo / redo keys work in Edit mode, as for every song-level change)
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.keyboard.press('Control+z');
  const undone = await storedSong(page, (s) => s.noteLength === 'played');
  check('desktop: one undo step puts As played back (and the library picture)', undone.noteLength === 'played' && JSON.stringify(undone.base) === JSON.stringify(song.base) && JSON.stringify(undone.basePedal) === JSON.stringify(song.basePedal) && undone.thumbnail === song.thumbnail && heard.thumbnail !== song.thumbnail);
  await page.keyboard.press('Control+Shift+z');
  const redone = await storedSong(page, (s) => s.noteLength === 'heard');
  check('desktop: redo gives As heard again', redone.noteLength === 'heard');
  await page.getByRole('button', { name: 'Editing', exact: true }).click();
  await page.reload();
  await page.locator('canvas').first().waitFor();
  await difficulty(page, 'Hard');
  await openPanel(page, 'Notes');
  check('desktop: As heard is remembered after a reload', (await noteLength(page).getByRole('radio', { name: 'As heard' }).getAttribute('aria-checked')) === 'true');
  await page.screenshot({ path: path.join(shots, 'desktop-as-heard-panel.png') });
  const xmlHeard = fs.readFileSync(await download(page, /^MusicXML \(hard\)/, path.join(work, 'heard.musicxml')), 'utf8');
  const wP = writtenLength(xmlPlayed);
  const wH = writtenLength(xmlHeard);
  check('desktop: the sheet follows (written note values as played <= 60 % of as heard)', wP <= 0.6 * wH, { asPlayedQuarters: +wP.toFixed(1), asHeardQuarters: +wH.toFixed(1) });
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: /Sheet music/ }).click();
  await page.waitForTimeout(2500);
  await closePanelIfOverlay(page);
  await page.screenshot({ path: path.join(shots, 'desktop-sheet-as-heard.png') });
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: /Piano roll/ }).click();
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'desktop-roll-as-heard.png') });
  if (withVideo) {
    const videoHeard = await exportVideo('heard.mp4');
    const times = [2, 5, 8, 11];
    const pP = times.reduce((s, t) => s + notePixels(videoPlayed, t), 0);
    const pH = times.reduce((s, t) => s + notePixels(videoHeard, t), 0);
    check('desktop: the video export follows (falling-note area as played <= 70 % of as heard)', pP > 0 && pP <= 0.7 * pH, { asPlayed: pP, asHeard: pH });
  }
  // back to As played (from As heard: the same notes again)
  await openPanel(page, 'Notes');
  await noteLength(page).getByRole('radio', { name: 'As played' }).click();
  const back = await storedSong(page, (s) => s.noteLength === 'played');
  check('desktop: back to As played gives exactly the same notes and pedal again', back.noteLength === 'played' && JSON.stringify(back.base) === JSON.stringify(song.base) && JSON.stringify(back.basePedal) === JSON.stringify(song.basePedal) && !back.notesAsPlayed);
  check('desktop: no sideways scroll', (await sideScroll(page)) <= 0);
  check('desktop: no console errors', !errors.length, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ======== iPhone 14
  {
    const { ctx: pctx, page: p, errors: perr } = await newPage({ ...devices['iPhone 14'] });
    const t = await importHighAccuracy(p, recording);
    console.log(`     iPhone: high-accuracy import took ${t.toFixed(0)} s`);
    await difficulty(p, 'Hard');
    const s = await getSong(p);
    checkPlayed('iPhone', s, shift);
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(shots, 'phone-roll-as-played.png') });
    await openPanel(p, 'Notes');
    await noteLength(p).scrollIntoViewIfNeeded();
    check('iPhone: Note length shows "As played"', (await noteLength(p).getByRole('radio', { name: 'As played' }).getAttribute('aria-checked')) === 'true');
    await p.screenshot({ path: path.join(shots, 'phone-note-length.png') });
    await noteLength(p).getByRole('radio', { name: 'As heard' }).tap();
    const h = await storedSong(p, (x) => x.noteLength === 'heard');
    check('iPhone: As heard switches (longer notes)', h.noteLength === 'heard' && median(h.arrangements.hard.notes.map((n) => n.dur)) > 2 * median(s.arrangements.hard.notes.map((n) => n.dur)));
    await p.reload();
    await p.locator('canvas').first().waitFor();
    await openPanel(p, 'Notes');
    check('iPhone: remembered after a reload', (await noteLength(p).getByRole('radio', { name: 'As heard' }).getAttribute('aria-checked')) === 'true');
    await noteLength(p).getByRole('radio', { name: 'As played' }).tap();
    await storedSong(p, (x) => x.noteLength === 'played');
    await closePanelIfOverlay(p);
    check('iPhone: no sideways scroll', (await sideScroll(p)) <= 0);
    check('iPhone: no console errors', !perr.length, perr.slice(0, 3).join(' | '));
    await pctx.close();
  }
} catch (err) {
  failed = true;
  console.error('FAIL', err.stack ?? err.message);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
