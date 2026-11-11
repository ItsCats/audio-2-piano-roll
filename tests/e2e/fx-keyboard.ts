// Dev-only visual harness for the realistic keyboard (src/lib/render/keyboardRealistic.ts).
//   /tests/e2e/fx-keyboard.html?w=1920&h=1080&lo=21&hi=108&theme=classic&kb=0.16&crop=1
//   /tests/e2e/fx-keyboard.html?mode=perf
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
  const ten = new Map([...pressed].slice(0, +(q.get('n') ?? 10)));
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
} else {
  bg();
  frame(pressed);
  (window as unknown as { __result: unknown }).__result = { ok: true };
}
