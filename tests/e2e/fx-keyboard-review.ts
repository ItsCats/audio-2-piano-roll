// Reviewer harness for keyboardRealistic.ts
import { drawRealisticKeyboard } from '../../src/lib/render/keyboardRealistic';
import { computeLayout } from '../../src/lib/render/layout';
import { hexToRgb, type RGB } from '../../src/lib/render/color';
import { KEYBOARD_THEMES, DEFAULT_VISUAL, applyTheme, type VisualSettings } from '../../src/lib/render/settings';
import { PianoRollRenderer } from '../../src/lib/render/renderer';
import type { Note } from '../../src/lib/music/types';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'full';
const W = +(q.get('w') ?? 1920);
const H = +(q.get('h') ?? 1080);
const out: Record<string, unknown> = {};
(window as any).__result = out;

function song(lo: number, hi: number): Note[] {
  const notes: Note[] = [];
  let id = 1;
  // chord of 10+ notes at t=1, extremes, short notes, a very long note
  const chord = [48, 52, 55, 59, 60, 62, 64, 66, 67, 69, 71, 72, 73];
  for (const m of chord) notes.push({ id: id++, midi: m, start: 1.0, dur: 2.0, vel: 0.8, hand: m < 60 ? 'L' : 'R' });
  notes.push({ id: id++, midi: lo, start: 0.98, dur: 2, vel: 0.9, hand: 'L' });
  notes.push({ id: id++, midi: lo + 1, start: 0.98, dur: 2, vel: 0.9, hand: 'L' });
  notes.push({ id: id++, midi: hi, start: 0.98, dur: 2, vel: 0.9, hand: 'R' });
  notes.push({ id: id++, midi: hi - 1, start: 0.98, dur: 2, vel: 0.9, hand: 'R' });
  notes.push({ id: id++, midi: 84, start: 0, dur: 30, vel: 0.9, hand: 'R' });
  for (let i = 0; i < 20; i++) notes.push({ id: id++, midi: 76 + (i % 5), start: 1.2 + i * 0.05, dur: 0.04, vel: 0.7, hand: 'R' });
  return notes;
}

function makeRenderer(theme: string, kbTheme: string, w: number, h: number) {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  let s: VisualSettings = applyTheme(structuredClone(DEFAULT_VISUAL), theme);
  s.keyboardStyle = 'realistic';
  if (kbTheme !== 'keep') {
    const k = (KEYBOARD_THEMES as any)[kbTheme];
    s.whiteKeyColor = k.white; s.blackKeyColor = k.black; s.keyBorderColor = k.border;
  }
  if (q.get('range')) s.range = q.get('range') as any;
  const r = new PianoRollRenderer(c, s);
  r.resize(w, h);
  r.setNotes(song(21, 108), [], null);
  return { r, c };
}

if (mode === 'full') {
  const { r } = makeRenderer(q.get('theme') ?? 'blossom', q.get('kb') ?? 'keep', W, H);
  r.render({ time: +(q.get('t') ?? 1.25) });
  out.ok = true;
}

if (mode === 'determinism') {
  const { r, c } = makeRenderer('blossom', 'keep', W, H);
  const cx = c.getContext('2d')!;
  const read = () => cx.getImageData(0, 0, W, H).data;
  r.render({ time: 1.25 });
  const a = read();
  r.render({ time: 0.3 });
  r.render({ time: 5 });
  r.render({ time: 1.25 });
  const b = read();
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  out.diff = d;
  // also via a fresh renderer (cold cache)
  const { r: r2, c: c2 } = makeRenderer('blossom', 'keep', W, H);
  r2.render({ time: 1.25 });
  const e = c2.getContext('2d')!.getImageData(0, 0, W, H).data;
  let d2 = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== e[i]) d2++;
  out.diffFresh = d2;
}

function direct(ctx: CanvasRenderingContext2D, w: number, h: number, lo: number, hi: number, press: Map<number, RGB>, theme = 'classic', glow = 0.7, kbFrac = 0.16) {
  const layout = computeLayout(w, lo, hi);
  const t = (KEYBOARD_THEMES as any)[theme];
  const kbH = Math.round(h * kbFrac);
  drawRealisticKeyboard(ctx, layout, (m) => press.get(m) ?? null, {
    top: h - kbH, height: kbH, width: w, scale: h / 1080,
    white: hexToRgb(t.white), black: hexToRgb(t.black), border: t.border,
    showOctaveLabels: true, glow, hitLine: true,
  });
  return layout;
}

if (mode === 'state') {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#123456'; ctx.strokeStyle = '#654321'; ctx.globalAlpha = 0.77; ctx.lineWidth = 3.5;
  ctx.globalCompositeOperation = 'multiply'; ctx.font = '13px serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.shadowBlur = 4; ctx.shadowColor = 'rgba(1,2,3,0.5)'; ctx.setTransform(1, 0, 0, 1, 3, 7);
  const snap = () => JSON.stringify([ctx.fillStyle, ctx.strokeStyle, ctx.globalAlpha, ctx.lineWidth, ctx.globalCompositeOperation, ctx.font, ctx.textAlign, ctx.textBaseline, ctx.shadowBlur, ctx.shadowColor, ctx.getTransform().toString()]);
  const before = snap();
  const blue = hexToRgb('#4f9dff');
  direct(ctx, W, H, 21, 108, new Map([[60, blue], [61, blue]]));
  out.same = before === snap(); out.before = before; out.after = snap();
  // also check transform respected: the keyboard drawn with translate(3,7) — fine either way
}

if (mode === 'edges') {
  // rows of keyboards: none, extreme keys, all keys pressed, dense chord
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#060608'; ctx.fillRect(0, 0, W, H);
  const lo = +(q.get('lo') ?? 21), hi = +(q.get('hi') ?? 108);
  const pal = [hexToRgb('#4f9dff'), hexToRgb('#f5a524'), hexToRgb('#34d399'), hexToRgb('#f4a6c6')];
  const sets: Map<number, RGB>[] = [
    new Map(),
    new Map([[lo, pal[0]], [lo + 1, pal[1]], [hi, pal[2]], [hi - 1, pal[3]]]),
    new Map(Array.from({ length: hi - lo + 1 }, (_, i) => [lo + i, pal[i % 4]] as [number, RGB])),
    new Map([48, 50, 52, 53, 55, 57, 59, 60, 61, 62, 63, 64].map((m, i) => [m, pal[i % 2]] as [number, RGB])),
  ];
  const rowH = Math.floor(H / sets.length);
  sets.forEach((s, i) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, i * rowH, W, rowH); ctx.clip();
    ctx.translate(0, i * rowH - (H - rowH));
    direct(ctx, W, H, lo, hi, s, q.get('theme') ?? 'classic', 0.7, rowH / H * 0.9);
    ctx.restore();
  });
  out.ok = true;
}

if (mode === 'perf') {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const ctx = c.getContext('2d', { alpha: false })!;
  const pal = [hexToRgb('#4f9dff'), hexToRgb('#f5a524')];
  const n = +(q.get('n') ?? 10);
  const spread = [22, 30, 37, 44, 51, 58, 63, 70, 78, 85, 94, 101, 106, 25, 33, 41];
  const press = new Map(spread.slice(0, n).map((m, i) => [m, pal[i % 2]] as [number, RGB]));
  const all = q.get('all') === '1' ? new Map(Array.from({ length: 88 }, (_, i) => [21 + i, pal[i % 2]] as [number, RGB])) : press;
  direct(ctx, W, H, 21, 108, all, q.get('theme') ?? 'classic');
  const N = 300;
  // varying sets to defeat any accidental caching
  const t0 = performance.now();
  for (let i = 0; i < N; i++) direct(ctx, W, H, 21, 108, all, q.get('theme') ?? 'classic');
  ctx.getImageData(0, 0, 1, 1);
  out.ms = (performance.now() - t0) / N;
  // full render cost comparison: realistic vs flat
  const { r } = makeRenderer('blossom', 'keep', W, H);
  r.render({ time: 1.25 });
  const t1 = performance.now();
  for (let i = 0; i < 60; i++) r.render({ time: 1.25 + i / 60 });
  (r.canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1);
  out.fullRealisticMs = (performance.now() - t1) / 60;
  // alternating sizes (live + export renderers) -> cache thrash?
  const t2 = performance.now();
  for (let i = 0; i < 20; i++) { direct(ctx, W, H, 21, 108, press); direct(ctx, 1280, 720, 21, 108, press); direct(ctx, 2560, 1440, 21, 108, press); direct(ctx, 800, 450, 36, 84, press); direct(ctx, 1080, 1920, 36, 84, press); }
  out.thrashMs = (performance.now() - t2) / 100;
}

if (mode === 'real') {
  // true production geometry, keyboard only, varied pressed sets
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#060608'; ctx.fillRect(0, 0, W, H);
  const lo = +(q.get('lo') ?? 21), hi = +(q.get('hi') ?? 108);
  const pal = [hexToRgb('#f5a524'), hexToRgb('#4f9dff'), hexToRgb('#7dffb0'), hexToRgb('#f4a6c6')];
  const keys = (q.get('keys') ?? '60,61,63,66,70,72').split(',').map(Number);
  const press = new Map(keys.map((m, i) => [m, pal[i % 4]] as [number, RGB]));
  direct(ctx, W, H, lo, hi, press, q.get('theme') ?? 'classic', +(q.get('glow') ?? 0.55), +(q.get('kb') ?? 0.16));
  out.ok = true;
}

if (mode === 'seam') {
  // pressed black key vs resting: diff outside the pressed key's own footprint (+ small margin)
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const lo = 21, hi = 108;
  const kbH = Math.round(H * 0.16);
  const layout = computeLayout(W, lo, hi);
  const res: unknown[] = [];
  for (const m of [61, 63, 66, 68, 70, 64, 65, 60]) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    direct(ctx, W, H, lo, hi, new Map(), q.get('theme') ?? 'classic', 0);
    const a = ctx.getImageData(0, H - kbH, W, kbH).data;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    direct(ctx, W, H, lo, hi, new Map([[m, hexToRgb('#4f9dff')]]), q.get('theme') ?? 'classic', 0);
    const b = ctx.getImageData(0, H - kbH, W, kbH).data;
    const k = layout.keys[m]!;
    let maxD = 0, cnt = 0, where: number[] = [];
    // look at columns of neighbouring keys: everything not within the pressed key's x range +- 4px
    for (let y = 0; y < kbH; y++) for (let x = 0; x < W; x++) {
      if (x >= k.x - 4 && x <= k.x + k.w + 6) continue;
      const i = (y * W + x) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 6) { cnt++; if (d > maxD) { maxD = d; where = [x, y]; } }
    }
    res.push({ m, black: k.black, cnt, maxD, where });
  }
  out.res = res;
}

if (mode === 'seamcol') {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const kbH = Math.round(H * 0.16);
  const layout = computeLayout(W, 21, 108);
  const m = +(q.get('m') ?? 61);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  direct(ctx, W, H, 21, 108, new Map(), 'classic', 0);
  const a = ctx.getImageData(0, H - kbH, W, kbH).data;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  direct(ctx, W, H, 21, 108, new Map([[m, hexToRgb('#4f9dff')]]), 'classic', 0);
  const b = ctx.getImageData(0, H - kbH, W, kbH).data;
  const k = layout.keys[m]!;
  const cols: string[] = [];
  for (let x = Math.floor(k.x - 14); x < Math.ceil(k.x + k.w + 20); x++) {
    let mx = 0, sgn = 0;
    for (let y = 0; y < kbH; y++) { const i = (y * W + x) * 4; const d = (b[i] + b[i+1] + b[i+2]) - (a[i] + a[i+1] + a[i+2]); if (Math.abs(d) > Math.abs(mx)) mx = d; }
    cols.push(`${x}:${mx}`);
  }
  out.k = [k.x, k.x + k.w]; out.cols = cols.join(' ');
}

if (mode === 'fullperf') {
  const res: Record<string, number> = {};
  for (const style of ['flat', 'realistic', 'flat', 'realistic']) {
    const c = document.createElement('canvas');
    const s: VisualSettings = applyTheme(structuredClone(DEFAULT_VISUAL), 'blossom');
    s.keyboardStyle = style as any;
    const r = new PianoRollRenderer(c, s);
    r.resize(W, H); r.setNotes(song(21, 108), [], null);
    r.render({ time: 1.25 });
    const t1 = performance.now();
    for (let i = 0; i < 60; i++) r.render({ time: 1.25 + i / 120 });
    c.getContext('2d')!.getImageData(0, 0, 1, 1);
    res[style] = (performance.now() - t1) / 60;
  }
  Object.assign(out, res);
}

if (mode === 'bloomthrash') {
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; document.body.appendChild(c);
  const ctx = c.getContext('2d', { alpha: false })!;
  const PC = ['#ff5a5f', '#ff8a4c', '#ffb547', '#ffd84d', '#c6e95b', '#6fdc7c', '#3fd2b5', '#3cb8f0', '#5b8cff', '#8c6cff', '#c35cf2', '#f25cb6'].map(hexToRgb);
  // 12 isolated keys covering all pitch classes (white + black), pitch-colour mode
  const keys = [24, 37, 50, 63, 76, 89, 102, 31, 44, 57, 70, 83];
  const press = new Map(keys.map((m) => [m, PC[m % 12]] as [number, RGB]));
  for (let i = 0; i < 5; i++) { direct(ctx, 1920, 1080, 21, 108, press); direct(ctx, 1280, 720, 21, 108, press); }
  let t0 = performance.now();
  for (let i = 0; i < 100; i++) direct(ctx, 1920, 1080, 21, 108, press);
  ctx.getImageData(0, 0, 1, 1);
  out.single = (performance.now() - t0) / 100;
  t0 = performance.now();
  for (let i = 0; i < 100; i++) { direct(ctx, 1920, 1080, 21, 108, press); direct(ctx, 1280, 720, 21, 108, press); }
  ctx.getImageData(0, 0, 1, 1);
  out.alternatingPerCall = (performance.now() - t0) / 200;
  t0 = performance.now();
  for (let i = 0; i < 100; i++) { direct(ctx, 1920, 1080, 21, 108, press, 'classic', 0); direct(ctx, 1280, 720, 21, 108, press, 'classic', 0); }
  ctx.getImageData(0, 0, 1, 1);
  out.alternatingNoGlow = (performance.now() - t0) / 200;
}
