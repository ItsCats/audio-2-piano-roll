// Dev-only harness for src/lib/render/effects.ts (bursts, dust, key light).
import { drawBursts, drawDust, drawKeyLight, DUST_LOOKBACK, type FxNote, type FxGeometry } from '../../src/lib/render/effects';
import { computeLayout } from '../../src/lib/render/layout';
import { hexToRgb, roundRect, type Ctx2D } from '../../src/lib/render/color';
import { DEFAULT_VISUAL, type EffectSettings } from '../../src/lib/render/settings';

const W = 1920;
const H = 1080;
const sc = H / 1080;
const kbH = 0.16 * H;
const hitY = H - kbH;
const L = computeLayout(W, 21, 108);

const GREEN = hexToRgb('#7dffb0');
const VIOLET = hexToRgb('#a88bff');

interface N { midi: number; start: number; dur: number; vel: number; hand: 'L' | 'R' }
// a chord at 1.0, a melody, and a dense block for the perf test
const song: N[] = [];
const chord = [48, 55, 60, 64, 67];
for (const m of chord) song.push({ midi: m, start: 1.0, dur: 3.0, vel: 0.8, hand: 'L' });
const mel = [72, 74, 76, 79, 81, 79, 76, 74];
mel.forEach((m, i) => song.push({ midi: m, start: 1.0 + i * 0.35, dur: 0.33, vel: 0.6 + 0.4 * ((i * 7) % 5) / 4, hand: 'R' }));
let id = 1;

function fxNotesAt(notes: N[], now: number): FxNote[] {
  const out: FxNote[] = [];
  for (const n of notes) {
    if (n.start <= now && n.start + n.dur > now - DUST_LOOKBACK) {
      const k = L.keys[n.midi]!;
      out.push({ id: id++, midi: n.midi, x: k.x + k.w / 2, w: k.w, black: k.black, color: n.hand === 'L' ? GREEN : VIOLET, start: n.start, end: n.start + n.dur, vel: n.vel });
    }
  }
  return out;
}

function drawScene(ctx: Ctx2D, notes: N[], now: number, fx: EffectSettings) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#060608';
  ctx.fillRect(0, 0, W, H);
  // guides
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let m = 24; m <= 108; m += 12) ctx.fillRect(L.keys[m]!.x, 0, 1, hitY);
  // falling notes (plain)
  const look = 3;
  const pxPerS = hitY / look;
  for (const n of notes) {
    const y1 = hitY - (n.start - now) * pxPerS;
    const y0 = hitY - (n.start + n.dur - now) * pxPerS;
    if (y1 < 0 || y0 > hitY) continue;
    const k = L.keys[n.midi]!;
    const c = n.hand === 'L' ? GREEN : VIOLET;
    ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
    roundRect(ctx, k.x + k.w * 0.08, Math.max(y0, -10), k.w * 0.84, Math.min(y1, hitY) - Math.max(y0, -10), 6);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // keyboard
  for (let m = L.lo; m <= L.hi; m++) {
    const k = L.keys[m];
    if (!k || k.black) continue;
    ctx.fillStyle = '#f2f2ef';
    ctx.fillRect(k.x + 1, hitY, k.w - 2, kbH);
  }
  for (let m = L.lo; m <= L.hi; m++) {
    const k = L.keys[m];
    if (!k || !k.black) continue;
    ctx.fillStyle = '#121216';
    ctx.fillRect(k.x, hitY, k.w, kbH * 0.62);
  }
  const g: FxGeometry = { width: W, height: H, hitY, kbH, scale: sc };
  const f = fxNotesAt(notes, now);
  if (fx.keyLight) drawKeyLight(ctx, f, now, g, fx);
  if (fx.bursts) drawBursts(ctx, f, now, g, fx);
  if (fx.dust) drawDust(ctx, f, now, g, fx);
}

const FX: EffectSettings = { ...DEFAULT_VISUAL.effects, bursts: true, dust: true, keyLight: true, burstIntensity: 0.8, dustAmount: 0.8, keyLightIntensity: 0.8 };
const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function off(): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c.getContext('2d', { willReadFrequently: true })!;
}

// dense passage: 10 active + 20 recently ended notes
function densePassage(now: number): N[] {
  const out: N[] = [];
  for (let i = 0; i < 10; i++) out.push({ midi: 40 + i * 5, start: now - 0.05 - i * 0.13, dur: 5, vel: 0.5 + (i % 5) / 10, hand: i % 2 ? 'R' : 'L' });
  for (let i = 0; i < 20; i++) out.push({ midi: 30 + i * 3, start: now - 1.4 - i * 0.07, dur: 0.6 + (i % 4) * 0.2, vel: 0.7, hand: i % 2 ? 'R' : 'L' });
  return out;
}

const api = {
  render(now: number, dense = false, only?: 'keyLight' | 'bursts' | 'dust') {
    const fx = only ? { ...FX, keyLight: only === 'keyLight', bursts: only === 'bursts', dust: only === 'dust' } : FX;
    drawScene(ctx, dense ? densePassage(now) : song, now, fx);
  },
  perf(frames = 120, flushEach = true) {
    const base = 10;
    // warm-up (builds sprites)
    for (let i = 0; i < 10; i++) drawScene(ctx, densePassage(base), base + i / 60, FX);
    const notesFor = (t: number) => densePassage(base); // fixed notes, moving time
    const g: FxGeometry = { width: W, height: H, hitY, kbH, scale: sc };
    const tFx = { key: 0, burst: 0, dust: 0, sceneOnly: 0 };
    let total = 0;
    for (let i = 0; i < frames; i++) {
      const now = base + 0.2 + i / 60;
      const notes = notesFor(now);
      drawScene(ctx, notes, now, { ...FX, bursts: false, dust: false, keyLight: false });
      const f = fxNotesAt(notes, now);
      ctx.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      drawKeyLight(ctx, f, now, g, FX);
      if (flushEach) ctx.getImageData(0, 0, 1, 1);
      const t1 = performance.now();
      drawBursts(ctx, f, now, g, FX);
      if (flushEach) ctx.getImageData(0, 0, 1, 1);
      const t2 = performance.now();
      drawDust(ctx, f, now, g, FX);
      // force rasterisation to be included in the timing
      ctx.getImageData(0, 0, 1, 1);
      const t3 = performance.now();
      tFx.key += t1 - t0;
      tFx.burst += t2 - t1;
      tFx.dust += t3 - t2;
      total += t3 - t0;
    }
    // measure the scene-only cost including the same flush, to subtract
    let sceneFlush = 0;
    for (let i = 0; i < frames; i++) {
      const now = base + 0.2 + i / 60;
      drawScene(ctx, notesFor(now), now, { ...FX, bursts: false, dust: false, keyLight: false });
      const t0 = performance.now();
      ctx.getImageData(0, 0, 1, 1);
      sceneFlush += performance.now() - t0;
    }
    // cost of a readback that has nothing to flush
    let empty = 0;
    for (let i = 0; i < frames; i++) {
      ctx.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      ctx.getImageData(0, 0, 1, 1);
      empty += performance.now() - t0;
    }
    const ov = empty / frames;
    return {
      readbackOverheadMs: ov,
      netTotalMs: total / frames - (flushEach ? 3 : 1) * ov,
      frames,
      fxCount: fxNotesAt(densePassage(base), base + 0.2).length,
      perFrameMs: total / frames,
      keyMs: tFx.key / frames,
      burstMs: tFx.burst / frames,
      dustPlusFlushMs: tFx.dust / frames,
      baselineFlushMs: sceneFlush / frames,
    };
  },
  determinism() {
    const a = off();
    const b = off();
    const c = off();
    drawScene(a, song, 2.3, FX);
    drawScene(b, song, 2.3, FX);
    const same = (x: CanvasRenderingContext2D, y: CanvasRenderingContext2D) => {
      const p = x.getImageData(0, 0, W, H).data;
      const q = y.getImageData(0, 0, W, H).data;
      let diff = 0;
      for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) diff++;
      return diff;
    };
    const d1 = same(a, b);
    // t = 5.0 fresh vs after rendering 1..4 (also clear the sprite cache path by varying colours)
    drawScene(a, song, 5.0, FX);
    for (let t = 1; t <= 4; t += 0.25) drawScene(c, song, t, FX);
    drawScene(c, song, 5.0, FX);
    const d2 = same(a, c);
    // dense at 3.3 vs 3.3 after 1..3
    drawScene(a, densePassage(3.3), 3.3, FX);
    for (let t = 1; t <= 3; t += 0.1) drawScene(b, densePassage(t), t, FX);
    drawScene(b, densePassage(3.3), 3.3, FX);
    const d3 = same(a, b);
    return { sameNowTwice: d1, t5FreshVsAfter: d2, denseFreshVsAfter: d3 };
  },
};
(window as unknown as { fx: typeof api }).fx = api;
(document.getElementById('log') as HTMLElement).textContent = 'ready';

// Full pipeline check: the real renderer with all effects on (and a decal, if available).
import { PianoRollRenderer } from '../../src/lib/render/renderer';
(window as unknown as { real: (t: number, theme?: Record<string, unknown>) => string }).real = (t, theme = {}) => {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const v = {
    ...DEFAULT_VISUAL,
    rightColor: '#b49cff',
    leftColor: '#7dffb0',
    decal: { ...DEFAULT_VISUAL.decal, source: 'pattern' as const },
    effects: { ...DEFAULT_VISUAL.effects, bursts: true, dust: true, keyLight: true, outlineGlow: 0.6 },
    ...theme,
  };
  const r = new PianoRollRenderer(c, v);
  r.resize(W, H);
  r.setNotes(
    song.map((n, i) => ({ id: i + 1, midi: n.midi, start: n.start, dur: n.dur, vel: n.vel, hand: n.hand })),
    [],
    null,
  );
  r.render({ time: t });
  return c.toDataURL('image/png');
};
