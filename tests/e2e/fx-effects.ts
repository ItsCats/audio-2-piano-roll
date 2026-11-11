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

// ---- review-fix checks -------------------------------------------------------------------
const NOTE1 = (over: Partial<FxNote> = {}): FxNote => ({ id: 1, midi: 60, x: 300, w: 37, black: false, color: { r: 125, g: 255, b: 176 }, start: 1, end: 5, vel: 0.8, ...over });
const DEF_FX: EffectSettings = { ...DEFAULT_VISUAL.effects, bursts: true, dust: true, keyLight: true };
(window as unknown as { chk: unknown }).chk = {
  /** single burst on black, 1080p scale, default intensity: luminance profile + hot-pixel extent */
  profile(t: number, end = 5) {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.fillStyle = '#000'; x.fillRect(0, 0, 600, 400);
    const g: FxGeometry = { width: 600, height: 400, hitY: 300, kbH: 100, scale: 1 };
    drawBursts(x, [NOTE1({ end })], t, g, DEF_FX);
    const d = x.getImageData(0, 0, 600, 400).data;
    const L = (px: number, py: number) => { const i = (py * 600 + px) * 4; return Math.round((d[i] + d[i + 1] + d[i + 2]) / 3); };
    const up: number[] = []; for (let dy = 0; dy <= 120; dy += 10) up.push(L(300, 300 - dy));
    let hot = 0, x0 = 600, x1 = -1, y0 = 400, y1 = -1;
    for (let py = 0; py < 400; py++) for (let px = 0; px < 600; px++) {
      const i = (py * 600 + px) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > 600) { hot++; if (py >= 295 && py <= 305 || true) { x0 = Math.min(x0, px); x1 = Math.max(x1, px); } y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
    }
    // width of the hot region on rows away from the thin horizontal streak (5..40 px above hit)
    let wMax = 0;
    for (let py = 260; py <= 295; py++) { let a = -1, b = -1; for (let px = 0; px < 600; px++) { const i = (py * 600 + px) * 4; if (d[i] + d[i + 1] + d[i + 2] > 600) { if (a < 0) a = px; b = px; } } if (a >= 0) wMax = Math.max(wMax, b - a + 1); }
    return { up, hotPx: hot, hotW: wMax, hotTop: 300 - y0, url: c.toDataURL() };
  },
  stateCheck() {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const x = c.getContext('2d')!;
    const notes: FxNote[] = [NOTE1({ x: 200, w: 20, start: 0 })];
    const res: Record<string, unknown> = {};
    for (const [name, fn, kb] of [['key', drawKeyLight, 40], ['keyTinyKb', drawKeyLight, 1.4], ['burst', drawBursts, 40], ['dust', drawDust, 40]] as const) {
      const g: FxGeometry = { width: 400, height: 300, hitY: 250, kbH: kb, scale: 300 / 1080 };
      x.globalAlpha = 0.5; x.globalCompositeOperation = 'source-over';
      x.save(); x.globalAlpha = 0.3; x.globalCompositeOperation = 'xor';
      (fn as typeof drawKeyLight)(x, notes, 1, g, DEF_FX);
      x.restore();
      res[name] = [x.globalAlpha, x.globalCompositeOperation];
      for (let i = 0; i < 5; i++) x.restore();
    }
    return res;
  },
  /** stress the sprite budget: many distinct colours at 1440p, all effects */
  evictAll(n = 600) {
    const c = document.createElement('canvas');
    c.width = 2560; c.height = 1440;
    const x = c.getContext('2d')!;
    const g: FxGeometry = { width: 2560, height: 1440, hitY: 1210, kbH: 230, scale: 1440 / 1080 };
    const errs: string[] = [];
    for (let i = 0; i < n; i++) {
      const notes: FxNote[] = [0, 1].map((j) => ({ id: j, midi: 60 + j, x: 900 + j * 300, w: 49, black: false, color: { r: (i * 37 + j * 50) % 256, g: (i * 91 + 40) % 256, b: (i * 53 + 100 + j * 70) % 256 }, start: 1, end: 5, vel: 0.8 }));
      for (const fn of [drawKeyLight, drawBursts, drawDust]) {
        try { fn(x, notes, 1.02 + (i % 3) * 0.5, g, DEF_FX); } catch (e) { errs.push(`${i} ${fn.name}: ${(e as Error).message}`); }
      }
    }
    return { count: errs.length, first: errs.slice(0, 3), op: x.globalCompositeOperation, alpha: x.globalAlpha };
  },
  colourDrag(frames = 400) {
    const c = document.createElement('canvas');
    const v = { ...DEFAULT_VISUAL, rightColor: '#b49cff', leftColor: '#7dffb0', decal: { ...DEFAULT_VISUAL.decal, source: 'pattern' as const }, effects: { ...DEF_FX, outlineGlow: 0.6 } };
    const r = new PianoRollRenderer(c, v);
    r.resize(2560, 1440);
    r.setNotes(song.map((n, i) => ({ id: i + 1, midi: n.midi, start: n.start, dur: n.dur, vel: n.vel, hand: n.hand })), [], null);
    const errs: string[] = [];
    const hx = (v: number) => Math.round(v).toString(16).padStart(2, '0');
    for (let i = 0; i < frames; i++) {
      const col = `#${hx(127 + 127 * Math.sin(i * 0.11))}${hx(127 + 127 * Math.sin(i * 0.17 + 2))}${hx(127 + 127 * Math.sin(i * 0.23 + 4))}`;
      r.setSettings({ ...v, rightColor: col, leftColor: `#${hx(255 - parseInt(col.slice(1, 3), 16))}${hx(255 - parseInt(col.slice(3, 5), 16))}${hx(255 - parseInt(col.slice(5, 7), 16))}` });
      try { r.render({ time: 1.05 + (i % 20) * 0.1 }); } catch (e) { errs.push(`${i}:${(e as Error).message}`); }
    }
    const x = c.getContext('2d')!;
    return { count: errs.length, first: errs.slice(0, 3), op: x.globalCompositeOperation };
  },
  /** effects-only timing with notes spread across the keyboard */
  perfFx(frames = 120, w = 1920, h = 1080) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { alpha: false })!;
    const s = h / 1080;
    const kb = 0.16 * h;
    const g: FxGeometry = { width: w, height: h, hitY: h - kb, kbH: kb, scale: s };
    const kw = w / 52;
    const mk = (now: number) => {
      const out: FxNote[] = [];
      for (let i = 0; i < 20; i++) out.push({ id: 100 + i, midi: 30 + i * 3, x: (i * 2.5 + 3) * kw, w: kw, black: false, color: i % 2 ? { r: 180, g: 156, b: 255 } : { r: 125, g: 255, b: 176 }, start: now - 1.4 - i * 0.07, end: now - 0.4 - i * 0.05, vel: 0.7 });
      for (let i = 0; i < 10; i++) out.push({ id: i, midi: 40 + i * 5, x: (i * 4 + 6) * kw, w: kw, black: false, color: i % 2 ? { r: 180, g: 156, b: 255 } : { r: 125, g: 255, b: 176 }, start: now - 0.05 - i * 0.13, end: now + 5, vel: 0.8 });
      return out.sort((a, b) => a.start - b.start);
    };
    const run = () => {
      let tk = 0, tb = 0, td = 0;
      for (let i = 0; i < frames; i++) {
        const now = 10 + i / 60;
        const notes = mk(10);
        x.fillStyle = '#060608'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#eee'; x.fillRect(0, g.hitY, w, kb);
        x.getImageData(0, 0, 1, 1);
        const a = performance.now(); drawKeyLight(x, notes, now, g, DEF_FX); x.getImageData(0, 0, 1, 1);
        const b = performance.now(); drawBursts(x, notes, now, g, DEF_FX); x.getImageData(0, 0, 1, 1);
        const d = performance.now(); drawDust(x, notes, now, g, DEF_FX); x.getImageData(0, 0, 1, 1);
        const e = performance.now();
        tk += b - a; tb += d - b; td += e - d;
      }
      const r2 = (v: number) => Math.round((v / frames) * 100) / 100;
      return { key: r2(tk), burst: r2(tb), dust: r2(td), total: r2(tk + tb + td) };
    };
    run();
    return run();
  },
  /** brightness (sum of R) of a 50 ms note's burst+key light just before/after note-off */
  release() {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 400;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    const g: FxGeometry = { width: 600, height: 400, hitY: 300, kbH: 100, scale: 1 };
    const out: Record<string, number> = {};
    for (const t of [1.03, 1.0467, 1.0634, 1.08, 1.0967, 1.1134, 1.13, 1.1467, 1.17, 1.19]) {
      x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
      x.fillStyle = '#000'; x.fillRect(0, 0, 600, 400);
      const n = [NOTE1({ end: 1.05 })];
      drawKeyLight(x, n, t, g, DEF_FX);
      drawBursts(x, n, t, g, DEF_FX);
      const d = x.getImageData(0, 0, 600, 400).data;
      let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i];
      out[t.toFixed(4)] = Math.round(sum / 1000);
    }
    return out;
  },
  /** grains visible above a single held note (count of bright small spots in a window) */
  fountain(t: number) {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 500;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.fillStyle = '#000'; x.fillRect(0, 0, 600, 500);
    const g: FxGeometry = { width: 600, height: 500, hitY: 400, kbH: 100, scale: 1 };
    let cores = 0;
    const fr = x.fillRect.bind(x);
    x.fillRect = (...a: [number, number, number, number]) => { cores++; fr(...a); };
    drawDust(x, [NOTE1({ end: 30 })], t, g, DEF_FX);
    x.fillRect = fr;
    (window as unknown as { __cores: number }).__cores = cores - 1;
    return c.toDataURL();
  },
};
(window as unknown as { __fx: unknown }).__fx = { drawDust, drawBursts, drawKeyLight };
