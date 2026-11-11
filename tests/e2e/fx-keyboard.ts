// Dev-only visual harness for the realistic keyboard (src/lib/render/keyboardRealistic.ts).
//   /tests/e2e/fx-keyboard.html?w=1920&h=1080&lo=21&hi=108&theme=classic&kb=0.16&crop=1
//   /tests/e2e/fx-keyboard.html?mode=perf | mode=perf2&n=16 | mode=seam&glow=0 | mode=seamall | mode=gallery
import { drawRealisticKeyboard } from '../../src/lib/render/keyboardRealistic';
import { computeLayout } from '../../src/lib/render/layout';
import { hexToRgb, type RGB } from '../../src/lib/render/color';
import { KEYBOARD_THEMES } from '../../src/lib/render/settings';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'scene';
const W = +(q.get('w') ?? 1920);
const H = +(q.get('h') ?? 1080);
const lo = +(q.get('lo') ?? 21);
const hi = +(q.get('hi') ?? 108);
const theme = (q.get('theme') ?? 'classic') as keyof typeof KEYBOARD_THEMES;
const kbFrac = +(q.get('kb') ?? 0.16);
const glow = +(q.get('glow') ?? 0.7);
const log = document.getElementById('log')!;

const c = document.createElement('canvas');
c.width = W;
c.height = H;
document.body.appendChild(c);
const ctx = c.getContext('2d')!;
const scale = H / 1080;
const kbH = Math.round(H * kbFrac);
const top = H - kbH;
const layout = computeLayout(W, lo, hi);
const t = KEYBOARD_THEMES[theme];
const blue = hexToRgb('#4f9dff');
const amber = hexToRgb('#f5a524');
const pressed = new Map<number, RGB>();
// left hand amber, right hand blue — mix of white & black keys, adjacent pairs too
for (const m of [43, 47, 50, 54, 55]) pressed.set(m, amber);
for (const m of [60, 64, 66, 67, 71, 72, 73]) pressed.set(m, blue);

function bg() {
  ctx.fillStyle = '#060608';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    if (k && m % 12 === 0) {
      ctx.beginPath();
      ctx.moveTo(k.x + 0.5, 0);
      ctx.lineTo(k.x + 0.5, top);
      ctx.stroke();
    }
  }
}

function frame(press: Map<number, RGB>) {
  drawRealisticKeyboard(ctx, layout, (m) => press.get(m) ?? null, {
    top,
    height: kbH,
    width: W,
    scale,
    white: hexToRgb(t.white),
    black: hexToRgb(t.black),
    border: t.border,
    showOctaveLabels: q.get('labels') !== '0',
    glow,
    hitLine: true,
  });
}

if (mode === 'perf') {
  bg();
  frame(pressed); // warm cache
  const spread = q.get('set') === 'spread';
  // worst case: isolated keys (no merged spans), half black
  const ten = spread
    ? new Map([30, 37, 44, 51, 58, 63, 70, 78, 85, 94].map((m, i) => [m, i % 2 ? blue : amber] as [number, RGB]))
    : new Map([...pressed].slice(0, +(q.get('n') ?? 10)));
  const N = 300;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) frame(ten);
  ctx.getImageData(0, 0, 1, 1);
  const ms = (performance.now() - t0) / N;
  // cold (cache miss) cost
  const t1 = performance.now();
  drawRealisticKeyboard(ctx, layout, () => null, {
    top, height: kbH, width: W, scale, white: { r: 250, g: 250, b: 250 }, black: hexToRgb(t.black), border: t.border,
    showOctaveLabels: true, glow, hitLine: true,
  });
  const cold = performance.now() - t1;
  log.textContent = JSON.stringify({ msPerFrame: ms, coldMs: cold, pressed: ten.size });
  (window as unknown as { __result: unknown }).__result = { msPerFrame: ms, coldMs: cold };
} else if (mode === 'scene') {
  bg();
  frame(pressed);
  (window as unknown as { __result: unknown }).__result = { ok: true };
}

// seam check: with glow off, pixels away from pressed keys must match the resting keyboard exactly
if (mode === 'seam') {
  const read = () => ctx.getImageData(0, top, W, kbH).data;
  bg();
  frame(new Map());
  const rest = read();
  bg();
  frame(pressed);
  const live = read();
  const ks = Math.min(scale, layout.whiteW / 34);
  const near = new Uint8Array(W);
  for (const m of pressed.keys()) {
    const k = layout.keys[m]!;
    const l = Math.floor(k.x - (k.black ? 14 * ks + 3 : 2));
    const r = Math.ceil(k.x + k.w + (k.black ? 20 * ks + 3 : 2));
    for (let x = Math.max(0, l); x < Math.min(W, r); x++) near[x] = 1;
  }
  let diff = 0;
  let maxD = 0;
  for (let y = 0; y < kbH; y++)
    for (let x = 0; x < W; x++) {
      if (near[x]) continue;
      const i = (y * W + x) * 4;
      const d = Math.abs(rest[i] - live[i]) + Math.abs(rest[i + 1] - live[i + 1]) + Math.abs(rest[i + 2] - live[i + 2]);
      if (d > 3) diff++;
      maxD = Math.max(maxD, d);
    }
  (window as unknown as { __result: unknown }).__result = { diff, maxD };
}

// seam check per black key (alone and in adjacent groups), glow off: per-column max |delta| of
// summed RGB vs. the resting keyboard. Outside the pressed keys' shadow footprints it must be ~0,
// and the delta profile must not step at the footprint edges.
//   ?mode=seamall
if (mode === 'seamall') {
  const ctxR = c.getContext('2d', { willReadFrequently: true })!;
  const read = () => ctxR.getImageData(0, top, W, kbH).data;
  const draw = (press: Map<number, RGB>) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawRealisticKeyboard(ctx, layout, (m) => press.get(m) ?? null, {
      top, height: kbH, width: W, scale, white: hexToRgb(t.white), black: hexToRgb(t.black), border: t.border,
      showOctaveLabels: true, glow: 0, hitLine: true,
    });
  };
  draw(new Map());
  const rest = read();
  const ks = Math.min(scale, layout.whiteW / 34);
  const groups: number[][] = [];
  for (let m = layout.lo; m <= layout.hi; m++) if (layout.keys[m]?.black) groups.push([m]);
  for (let m = layout.lo; m <= layout.hi; m++) if (m % 12 === 1 && layout.keys[m + 2]) groups.push([m, m + 2]);
  for (let m = layout.lo; m <= layout.hi; m++) if (m % 12 === 6 && layout.keys[m + 4]) groups.push([m, m + 2, m + 4]);
  let worstOutside = 0;
  let worstStep = 0;
  const bad: unknown[] = [];
  for (const grp of groups) {
    draw(new Map(grp.map((m) => [m, blue] as [number, RGB])));
    const live = read();
    const col = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      let mx = 0;
      for (let y = 0; y < kbH; y++) {
        const i = (y * W + x) * 4;
        const d = Math.abs(live[i] + live[i + 1] + live[i + 2] - rest[i] - rest[i + 1] - rest[i + 2]);
        if (d > mx) mx = d;
      }
      col[x] = mx;
    }
    // footprint (generous) and key bodies (+ pressed key's own short shadow)
    const fp = new Uint8Array(W);
    const body = new Uint8Array(W);
    for (const m of grp) {
      const k = layout.keys[m]!;
      for (let x = Math.max(0, Math.floor(k.x - 16 * ks - 3)); x < Math.min(W, Math.ceil(k.x + k.w + 22 * ks + 3)); x++) fp[x] = 1;
      for (let x = Math.max(0, Math.floor(k.x - 6 * ks - 2)); x < Math.min(W, Math.ceil(k.x + k.w + 6 * ks + 2)); x++) body[x] = 1;
    }
    let out = 0;
    let step = 0; // |delta| right at the redraw-zone edges (same formula as keyboardRealistic.ts)
    for (let x = 0; x < W; x++) if (!fp[x]) out = Math.max(out, col[x]);
    for (const m of grp) {
      const k = layout.keys[m]!;
      for (const e of [Math.floor(k.x - Math.ceil(14 * ks + 2)), Math.ceil(k.x + k.w + Math.ceil(20 * ks + 2))])
        if (!grp.some((o) => o !== m && Math.abs(layout.keys[o]!.x + layout.keys[o]!.w / 2 - e) < 22 * ks + layout.keys[o]!.w))
          for (let x = e - 3; x <= e + 3; x++) if (x >= 0 && x < W && !body[x]) step = Math.max(step, col[x]);
    }
    worstOutside = Math.max(worstOutside, out);
    worstStep = Math.max(worstStep, step);
    if (out > 3 || step > 3) bad.push({ grp, out, step });
  }
  (window as unknown as { __result: unknown }).__result = { groups: groups.length, worstOutside, worstStep, bad: bad.slice(0, 10) };
}

// ?mode=perf2&n=16 | &all=1 | &pc=1 (12 pitch colours)
if (mode === 'perf2') {
  const PC = ['#ff5a5f', '#ff8a4c', '#ffb547', '#ffd84d', '#c6e95b', '#6fdc7c', '#3fd2b5', '#3cb8f0', '#5b8cff', '#8c6cff', '#c35cf2', '#f25cb6'].map(hexToRgb);
  const spread = [22, 30, 37, 44, 51, 58, 63, 70, 78, 85, 94, 101, 106, 25, 33, 41];
  const nn = +(q.get('n') ?? 10);
  let press: Map<number, RGB>;
  if (q.get('all') === '1') press = new Map(Array.from({ length: 88 }, (_, i) => [21 + i, i % 2 ? blue : amber] as [number, RGB]));
  else if (q.get('pc') === '1') press = new Map([24, 37, 50, 63, 76, 89, 102, 31, 44, 57, 70, 83].map((m) => [m, PC[m % 12]] as [number, RGB]));
  else press = new Map(spread.slice(0, nn).map((m, i) => [m, i % 2 ? blue : amber] as [number, RGB]));
  for (let i = 0; i < 5; i++) frame(press);
  const N = 300;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) frame(press);
  ctx.getImageData(0, 0, 1, 1);
  (window as unknown as { __result: unknown }).__result = { ms: (performance.now() - t0) / N, pressed: press.size };
}

// ?mode=gallery: rows with every highlight colour on black & white keys
if (mode === 'gallery') {
  bg();
  const PC = ['#f5a524', '#4f9dff', '#7dffb0', '#f4a6c6', '#ffd84d', '#ff5a5f', '#8c6cff', '#34d399'].map(hexToRgb);
  const keys = (q.get('keys') ?? '54,56,58,60,61,63,66,68,70,72,73,75').split(',').map(Number);
  frame(new Map(keys.map((m, i) => [m, PC[i % PC.length]] as [number, RGB])));
  (window as unknown as { __result: unknown }).__result = { ok: true };
}
