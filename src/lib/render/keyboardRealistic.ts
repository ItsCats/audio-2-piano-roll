/**
 * Photo-like piano keyboard.
 *
 * CONTRACT (used by renderer.ts — keep this signature). Draws the whole keyboard region
 * (from `top` to `top + height`), including the felt strip at the top edge. `keyColor`
 * returns the highlight colour for a pressed key, or null when the key is up.
 *
 * Rendering strategy: the resting keyboard (felt, ivory keys, glossy black keys, shadows,
 * labels) is painted once into an offscreen canvas and cached. Each frame blits that cache,
 * then re-paints only the narrow vertical spans around pressed keys (clipped, so neighbouring
 * keys and black-key shadows inside a span are redrawn consistently), and finally adds the
 * additive glow of pressed keys. Everything is a pure function of the inputs.
 */
import type { KeyboardLayout } from './layout';
import { BLACK_RGB, WHITE, hash, makeCanvas, mix, rgba, roundRect, type AnyCanvas, type Ctx2D, type RGB } from './color';

export interface RealisticKeyboardOptions {
  top: number;
  height: number;
  width: number;
  scale: number;
  white: RGB;
  black: RGB;
  border: string;
  /** draw "C4"-style labels on C keys */
  showOctaveLabels: boolean;
  /** 0..1 glow strength for pressed keys */
  glow: number;
  hitLine: boolean;
}

/** Derived geometry, all in keyboard-local coordinates (y = 0 at `top`). */
interface Geo {
  w: number;
  h: number;
  sc: number;
  felt: number; // felt strip height
  ky: number; // top of keys
  kh: number; // key length (to bottom of region minus key bed)
  lip: number; // visible front face of white keys
  bed: number; // dark key bed below the white keys
  blackLen: number;
  gap: number; // gap between white keys
  shadowPad: number; // horizontal reach of black-key shadows
  white: RGB;
  black: RGB;
  border: RGB;
  darkTheme: boolean;
  labels: boolean;
}

const FONT = 'Inter Variable, Inter, system-ui, sans-serif';
const lum = (c: RGB) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const shade = (c: RGB, t: number): RGB => (t >= 0 ? mix(c, WHITE, t) : mix(c, BLACK_RGB, -t));
const css = (c: RGB) => `rgb(${c.r},${c.g},${c.b})`;

function parseColor(s: string, fallback: RGB): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const r = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(s);
  if (r) return { r: +r[1], g: +r[2], b: +r[3] };
  return fallback;
}

function geometry(layout: KeyboardLayout, o: RealisticKeyboardOptions): Geo {
  const sc = Math.max(0.2, o.scale);
  const h = Math.max(1, Math.round(o.height));
  const felt = Math.max(2, Math.round(Math.min(6 * sc, h * 0.06)));
  const bed = Math.max(1, Math.round(Math.min(3 * sc, h * 0.018)));
  const ky = felt;
  const kh = Math.max(1, h - felt - bed);
  const lip = Math.max(2, Math.min(kh * 0.055, 10 * sc));
  const gap = Math.max(1, Math.min(1.5 * sc, layout.whiteW * 0.07));
  return {
    w: Math.max(1, Math.round(o.width)),
    h,
    sc,
    felt,
    ky,
    kh,
    lip,
    bed,
    blackLen: kh * 0.63,
    gap,
    shadowPad: Math.ceil(10 * sc + 2),
    white: o.white,
    black: o.black,
    border: parseColor(o.border, shade(o.black, 0.05)),
    darkTheme: lum(o.white) < 0.45,
    labels: o.showOctaveLabels,
  };
}

// ---------------------------------------------------------------------------------------------
// key painters (local coordinates; caller translates)

function drawWhiteKey(ctx: Ctx2D, g: Geo, midi: number, x: number, w: number, hc: RGB | null): void {
  const pressed = hc !== null;
  const xl = x + g.gap / 2;
  const kw = Math.max(1, w - g.gap);
  const jitter = (hash(midi, 7) - 0.5) * 0.035; // tiny per-key tone variation, like real ivories
  let c = shade(g.white, jitter);
  if (pressed) c = shade(mix(g.white, hc!, g.darkTheme ? 0.62 : 0.5), -0.04);
  const dip = pressed ? Math.max(1, g.lip * 0.45) : 0;
  const lip = pressed ? g.lip * 0.5 : g.lip;
  const yTop = g.ky;
  const yBot = g.ky + g.kh - dip; // bottom of the front face
  const ySurf = yBot - lip; // front edge of the top surface
  const r = Math.min(kw * 0.12, 3 * g.sc);

  // top surface
  const sg = ctx.createLinearGradient(0, yTop, 0, ySurf);
  const surfLen = Math.max(1, ySurf - yTop);
  const f = (px: number) => Math.min(0.99, px / surfLen);
  sg.addColorStop(0, css(shade(c, pressed ? -0.5 : -0.38)));
  sg.addColorStop(f(4 * g.sc), css(shade(c, pressed ? -0.26 : -0.16)));
  sg.addColorStop(f(14 * g.sc), css(shade(c, pressed ? -0.08 : -0.03)));
  if (pressed) {
    // light pooling where the note lands, fading toward the player
    sg.addColorStop(f(20 * g.sc), css(shade(mix(c, hc!, 0.35), 0.12)));
    sg.addColorStop(0.55, css(c));
  } else {
    sg.addColorStop(0.45, css(shade(c, 0.02)));
  }
  sg.addColorStop(1, css(shade(c, pressed ? -0.06 : 0.04)));
  ctx.fillStyle = sg;
  ctx.fillRect(xl, yTop, kw, ySurf - yTop + 0.5);

  // subtle horizontal modelling: lit left edge, shaded right edge
  const hg = ctx.createLinearGradient(xl, 0, xl + kw, 0);
  if (pressed) {
    hg.addColorStop(0, 'rgba(0,0,0,0.30)');
    hg.addColorStop(0.16, 'rgba(0,0,0,0.04)');
    hg.addColorStop(0.84, 'rgba(0,0,0,0.04)');
    hg.addColorStop(1, 'rgba(0,0,0,0.32)');
  } else {
    hg.addColorStop(0, g.darkTheme ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.45)');
    hg.addColorStop(0.1, 'rgba(255,255,255,0)');
    hg.addColorStop(0.78, 'rgba(0,0,0,0)');
    hg.addColorStop(1, g.darkTheme ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.10)');
  }
  ctx.fillStyle = hg;
  ctx.fillRect(xl, yTop, kw, ySurf - yTop);

  // front face (lip): rounded edge catching light, then the darker vertical face
  const lg = ctx.createLinearGradient(0, ySurf, 0, yBot);
  lg.addColorStop(0, css(shade(c, pressed ? 0.05 : 0.35)));
  lg.addColorStop(0.22, css(shade(c, pressed ? -0.12 : -0.02)));
  lg.addColorStop(0.6, css(shade(c, pressed ? -0.3 : -0.18)));
  lg.addColorStop(1, css(shade(c, pressed ? -0.45 : -0.36)));
  ctx.fillStyle = lg;
  roundRect(ctx, xl, ySurf - r, kw, yBot - ySurf + r, r);
  ctx.fill();
  // re-cover the rounded top of the lip shape with the surface colour band
  ctx.fillStyle = css(shade(c, pressed ? -0.06 : 0.04));
  ctx.fillRect(xl, ySurf - r, kw, r);
  // crisp edge highlight
  ctx.fillStyle = pressed ? 'rgba(255,255,255,0.10)' : g.darkTheme ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)';
  ctx.fillRect(xl + r * 0.5, ySurf, Math.max(0, kw - r), Math.max(1, 0.8 * g.sc));

  if (g.labels && midi % 12 === 0 && kw > 8 * g.sc) {
    const size = Math.min(11 * g.sc, kw * 0.42);
    const lc = lum(c);
    ctx.fillStyle = pressed
      ? lc > 0.6
        ? 'rgba(0,0,0,0.45)'
        : 'rgba(255,255,255,0.8)'
      : lc > 0.5
        ? 'rgba(0,0,0,0.30)'
        : 'rgba(255,255,255,0.32)';
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`C${Math.floor(midi / 12) - 1}`, xl + kw / 2, ySurf - 5 * g.sc);
  }
}

function drawBlackKey(ctx: Ctx2D, g: Geo, x: number, w: number, hc: RGB | null): void {
  const pressed = hc !== null;
  const sc = g.sc;
  const len = g.blackLen * (pressed ? 0.975 : 1);
  const y0 = g.ky - 1;
  const y1 = g.ky + len;
  const r = Math.min(w * 0.14, 3 * sc);
  const b = pressed ? mix(g.black, hc!, 0.42) : g.black;

  // drop shadow onto the ivories (+ a soft contact shadow hugging the key)
  ctx.save();
  ctx.shadowColor = g.darkTheme ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.42)';
  ctx.shadowBlur = (pressed ? 4 : 9) * sc;
  ctx.shadowOffsetX = (pressed ? 0.8 : 2.5) * sc;
  ctx.shadowOffsetY = (pressed ? 1.5 : 5) * sc;
  ctx.fillStyle = css(shade(g.border, -0.2));
  roundRect(ctx, x, y0, w, y1 - y0, r);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, x - 0.6 * sc, y0, w + 1.2 * sc, y1 - y0 + 0.8 * sc, r);
  ctx.fill();

  // base body (sides of the key are bevelled: the top is narrower than the base)
  const bev = Math.max(1, w * 0.11);
  const front = Math.max(3 * sc, len * (pressed ? 0.065 : 0.1));
  const ySurf = y1 - front;
  const bodyG = ctx.createLinearGradient(x, 0, x + w, 0);
  bodyG.addColorStop(0, css(shade(b, 0.2)));
  bodyG.addColorStop(0.12, css(shade(b, 0.1)));
  bodyG.addColorStop(0.88, css(shade(b, 0.02)));
  bodyG.addColorStop(1, css(shade(b, -0.3)));
  ctx.fillStyle = bodyG;
  roundRect(ctx, x, y0, w, y1 - y0, r);
  ctx.fill();

  // front face: rounded, lighter, catching the light
  const fg = ctx.createLinearGradient(0, ySurf, 0, y1);
  fg.addColorStop(0, css(shade(b, 0.34)));
  fg.addColorStop(0.18, css(shade(b, 0.18)));
  fg.addColorStop(0.7, css(shade(b, 0.1)));
  fg.addColorStop(1, css(shade(b, -0.2)));
  ctx.fillStyle = fg;
  roundRect(ctx, x + bev * 0.35, ySurf, w - bev * 0.7, y1 - ySurf - 0.6 * sc, r);
  ctx.fill();

  // top surface (inset by the bevels)
  const tx = x + bev;
  const tw = Math.max(1, w - bev * 2);
  const tg = ctx.createLinearGradient(0, y0, 0, ySurf);
  tg.addColorStop(0, css(shade(b, -0.5)));
  tg.addColorStop(0.08, css(shade(b, -0.15)));
  tg.addColorStop(0.55, css(b));
  tg.addColorStop(1, css(shade(b, pressed ? 0.14 : 0.09)));
  ctx.fillStyle = tg;
  roundRect(ctx, tx, y0, tw, ySurf - y0, Math.min(r * 0.6, tw / 3));
  ctx.fill();

  // glossy specular streak running along the key
  const sx = tx + tw * 0.18;
  const sw = Math.max(0.8, tw * 0.16);
  const sy0 = y0 + len * 0.1;
  const sy1 = ySurf - len * 0.03;
  const spec = ctx.createLinearGradient(0, sy0, 0, sy1);
  const sa = pressed ? 0.26 : 0.17;
  spec.addColorStop(0, 'rgba(255,255,255,0)');
  spec.addColorStop(0.45, `rgba(255,255,255,${sa * 0.6})`);
  spec.addColorStop(0.9, `rgba(255,255,255,${sa})`);
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  roundRect(ctx, sx, sy0, sw, sy1 - sy0, sw / 2);
  ctx.fill();

  // bright rim where the top surface rolls over into the front face
  ctx.fillStyle = `rgba(255,255,255,${pressed ? 0.3 : 0.22})`;
  ctx.fillRect(tx + tw * 0.08, ySurf - 0.4 * sc, tw * 0.84, Math.max(0.8, 0.9 * sc));
  // little glint on the front face
  ctx.fillStyle = `rgba(255,255,255,${pressed ? 0.22 : 0.14})`;
  ctx.fillRect(x + w * 0.3, ySurf + front * 0.42, w * 0.4, Math.max(0.8, 0.8 * sc));
}

// ---------------------------------------------------------------------------------------------

function drawFelt(ctx: Ctx2D, g: Geo): void {
  const fg = ctx.createLinearGradient(0, 0, 0, g.felt);
  fg.addColorStop(0, '#6a1a26');
  fg.addColorStop(0.35, '#4c111b');
  fg.addColorStop(1, '#2a070d');
  ctx.fillStyle = fg;
  ctx.fillRect(0, 0, g.w, g.felt);
  // fibre texture (static, cached)
  const step = Math.max(1, Math.round(g.sc));
  for (let y = 0; y < g.felt; y += step) {
    for (let x = 0; x < g.w; x += step * 2) {
      const n = hash(x * 13 + 1, y * 7 + 3);
      if (n < 0.55) continue;
      ctx.fillStyle = n > 0.85 ? 'rgba(255,170,170,0.07)' : 'rgba(0,0,0,0.16)';
      ctx.fillRect(x + (n > 0.7 ? step : 0), y, step, step);
    }
  }
  ctx.fillStyle = 'rgba(255,200,200,0.12)';
  ctx.fillRect(0, 0, g.w, Math.max(1, Math.round(0.8 * g.sc)));
}

function drawRange(ctx: Ctx2D, layout: KeyboardLayout, g: Geo, colors: (RGB | null)[], x0: number, x1: number): void {
  // white keys
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    if (!k || k.black || k.x > x1 || k.x + k.w < x0) continue;
    drawWhiteKey(ctx, g, m, k.x, k.w, colors[m - layout.lo]);
  }
  // black keys (including those whose shadow reaches into the range)
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    if (!k || !k.black || k.x - g.shadowPad > x1 || k.x + k.w + g.shadowPad < x0) continue;
    drawBlackKey(ctx, g, k.x, k.w, colors[m - layout.lo]);
  }
}

function drawStatic(ctx: Ctx2D, layout: KeyboardLayout, g: Geo): void {
  // key bed / gaps
  ctx.fillStyle = css(shade(g.border, -0.35));
  ctx.fillRect(0, 0, g.w, g.h);
  const none: (RGB | null)[] = new Array(layout.hi - layout.lo + 1).fill(null);
  drawRange(ctx, layout, g, none, -1e9, 1e9);
  drawFelt(ctx, g);
  // shadow cast by the felt / fallboard onto the keys
  const sh = ctx.createLinearGradient(0, g.felt, 0, g.felt + 6 * g.sc);
  sh.addColorStop(0, 'rgba(0,0,0,0.45)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, g.felt, g.w, 6 * g.sc);
}

// small LRU of static keyboards (live view + export renderers may coexist)
const cache = new Map<string, AnyCanvas>();
const CACHE_MAX = 4;

function staticKeyboard(layout: KeyboardLayout, g: Geo): AnyCanvas {
  const key = [g.w, g.h, g.sc.toFixed(4), layout.lo, layout.hi, layout.width.toFixed(2), css(g.white), css(g.black), css(g.border), g.labels].join('|');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const c = makeCanvas(g.w, g.h);
  const cctx = c.getContext('2d') as Ctx2D;
  drawStatic(cctx, layout, g);
  cache.set(key, c);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return c;
}

export function drawRealisticKeyboard(
  ctx: Ctx2D,
  layout: KeyboardLayout,
  keyColor: (midi: number) => RGB | null,
  o: RealisticKeyboardOptions,
): void {
  if (o.height <= 0 || o.width <= 0) return;
  const g = geometry(layout, o);
  const top = Math.round(o.top);
  const n = layout.hi - layout.lo + 1;
  const colors: (RGB | null)[] = new Array(n);
  const spans: [number, number][] = [];
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    const c = k ? keyColor(m) : null;
    colors[m - layout.lo] = c;
    if (c && k) {
      const pad = k.black ? g.shadowPad : 1;
      spans.push([Math.floor(k.x - pad), Math.ceil(k.x + k.w + pad)]);
    }
  }

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.filter = 'none';

  // soft hit-line highlight just above the keyboard
  if (o.hitLine) {
    const hh = 16 * g.sc;
    const hg = ctx.createLinearGradient(0, top - hh, 0, top);
    hg.addColorStop(0, 'rgba(255,255,255,0)');
    hg.addColorStop(1, 'rgba(255,255,255,0.13)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, top - hh, g.w, hh);
  }

  ctx.drawImage(staticKeyboard(layout, g), 0, top);
  if (o.hitLine) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(0, top, g.w, Math.max(1, Math.round(1.2 * g.sc)));
  }

  if (spans.length) {
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    ctx.translate(0, top);
    for (const [a, b] of merged) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(a, g.felt, b - a, g.h - g.felt);
      ctx.clip();
      ctx.fillStyle = css(shade(g.border, -0.35));
      ctx.fillRect(a, g.felt, b - a, g.h - g.felt);
      drawRange(ctx, layout, g, colors, a, b);
      const sh = ctx.createLinearGradient(0, g.felt, 0, g.felt + 6 * g.sc);
      sh.addColorStop(0, 'rgba(0,0,0,0.45)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh;
      ctx.fillRect(a, g.felt, b - a, 6 * g.sc);
      ctx.restore();
    }

    // gentle additive glow on pressed keys
    if (o.glow > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, g.w, g.h);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      for (let m = layout.lo; m <= layout.hi; m++) {
        const c = colors[m - layout.lo];
        const k = layout.keys[m];
        if (!c || !k) continue;
        const cx = k.x + k.w / 2;
        const len = k.black ? g.blackLen : g.kh;
        const a = Math.min(1, o.glow) * (g.darkTheme ? 0.6 : 0.42);
        // light pooled at the top of the key, spilling a little onto neighbours
        const rad = Math.max(k.w * 1.6, 18 * g.sc);
        const rg = ctx.createRadialGradient(cx, g.felt, 0, cx, g.felt, rad);
        rg.addColorStop(0, rgba(mix(c, WHITE, 0.35), a * 0.9));
        rg.addColorStop(0.35, rgba(c, a * 0.4));
        rg.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - rad, 0, rad * 2, rad);
        // along the key body
        const vg = ctx.createLinearGradient(0, g.felt, 0, g.ky + len);
        vg.addColorStop(0, rgba(c, a * 0.55));
        vg.addColorStop(1, rgba(c, a * 0.06));
        ctx.fillStyle = vg;
        const inset = k.black ? k.w * 0.12 : g.gap;
        ctx.fillRect(k.x + inset, g.felt, k.w - inset * 2, len);
      }
      ctx.restore();
    }
  }
  ctx.restore();
}
