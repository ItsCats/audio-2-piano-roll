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
  /** detail scale for key-sized features (shadows, radii): never larger than the keys allow */
  ks: number;
  felt: number; // felt strip height
  ky: number; // top of keys
  kh: number; // key length (to bottom of region minus key bed)
  lip: number; // visible front face of white keys
  bed: number; // dark key bed below the white keys
  blackLen: number;
  gap: number; // gap between white keys
  shadowL: number; // left reach of a resting black key's shadow
  shadowR: number; // right reach
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
  const ks = Math.max(0.2, Math.min(sc, layout.whiteW / 34));
  return {
    w: Math.max(1, Math.round(o.width)),
    h,
    sc,
    ks,
    felt,
    ky,
    kh,
    lip,
    bed,
    blackLen: kh * 0.63,
    gap,
    shadowL: Math.ceil(7 * ks + 2),
    shadowR: Math.ceil(12 * ks + 2),
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
  if (pressed) c = shade(mix(g.white, hc!, g.darkTheme ? 0.66 : 0.56), -0.03);
  const dip = pressed ? Math.max(1, g.lip * 0.45) : 0;
  const lip = pressed ? g.lip * 0.5 : g.lip;
  const yTop = g.ky;
  const yBot = g.ky + g.kh - dip; // bottom of the front face
  const ySurf = yBot - lip; // front edge of the top surface
  const r = Math.min(kw * 0.12, 3 * g.ks);

  // top surface
  const sg = ctx.createLinearGradient(0, yTop, 0, ySurf);
  const surfLen = Math.max(1, ySurf - yTop);
  const f = (px: number) => Math.min(0.99, px / surfLen);
  if (pressed) {
    // depressed key: deeper shadow under the felt, then light pooling where the note lands
    sg.addColorStop(0, css(shade(mix(c, hc!, 0.4), -0.55)));
    sg.addColorStop(f(4 * g.sc), css(shade(mix(c, hc!, 0.3), -0.2)));
    sg.addColorStop(f(12 * g.sc), css(mix(mix(c, hc!, 0.15), WHITE, 0.32)));
    sg.addColorStop(0.3, css(mix(c, WHITE, 0.1)));
    sg.addColorStop(0.7, css(c));
  } else {
    sg.addColorStop(0, css(shade(c, -0.38)));
    sg.addColorStop(f(4 * g.sc), css(shade(c, -0.16)));
    sg.addColorStop(f(14 * g.sc), css(shade(c, -0.03)));
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
  const sc = g.ks;
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

/** Shadow cast by the felt / fallboard onto the keys (drawn last, over black keys too). */
function drawFeltShadow(ctx: Ctx2D, g: Geo, x0: number, x1: number): void {
  const d = 7 * g.sc;
  const sh = ctx.createLinearGradient(0, g.felt, 0, g.felt + d);
  sh.addColorStop(0, 'rgba(0,0,0,0.5)');
  sh.addColorStop(0.4, 'rgba(0,0,0,0.16)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(x0, g.felt, x1 - x0, d);
}

interface StaticKb {
  /** felt + resting white keys + key bed (no black keys) */
  whites: AnyCanvas;
  /** resting black keys with their shadows, on transparent */
  blacks: AnyCanvas;
  /** whites + blacks + felt shadow: what a frame with no pressed keys shows */
  full: AnyCanvas;
}

function ctxOf(c: AnyCanvas): Ctx2D {
  return c.getContext('2d') as Ctx2D;
}

function buildStatic(layout: KeyboardLayout, g: Geo): StaticKb {
  const whites = makeCanvas(g.w, g.h);
  const wc = ctxOf(whites);
  wc.fillStyle = css(shade(g.border, -0.35));
  wc.fillRect(0, 0, g.w, g.h);
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    if (k && !k.black) drawWhiteKey(wc, g, m, k.x, k.w, null);
  }
  drawFelt(wc, g);

  const blacks = makeCanvas(g.w, g.h);
  const bc = ctxOf(blacks);
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    if (k && k.black) drawBlackKey(bc, g, k.x, k.w, null);
  }
  // the felt sits above the black keys' back ends
  bc.clearRect(0, 0, g.w, g.felt);

  const full = makeCanvas(g.w, g.h);
  const fc = ctxOf(full);
  fc.drawImage(whites, 0, 0);
  fc.drawImage(blacks, 0, 0);
  drawFeltShadow(fc, g, 0, g.w);
  return { whites, blacks, full };
}

// small LRUs (live view + export renderers may coexist)
const staticCache = new Map<string, StaticKb>();
const bloomCache = new Map<string, AnyCanvas>();

function lru<T>(map: Map<string, T>, key: string, max: number, make: () => T): T {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const v = make();
  map.set(key, v);
  while (map.size > max) map.delete(map.keys().next().value as string);
  return v;
}

/** Soft additive light pool for a pressed key: radial, centred on the top edge. */
function bloomSprite(c: RGB, r: number): AnyCanvas {
  return lru(bloomCache, `${css(c)}|${r}`, 24, () => {
    const cv = makeCanvas(r * 2, r);
    const x = ctxOf(cv);
    const rg = x.createRadialGradient(r, 0, 0, r, 0, r);
    rg.addColorStop(0, rgba(mix(c, WHITE, 0.55), 1));
    rg.addColorStop(0.12, rgba(mix(c, WHITE, 0.25), 0.75));
    rg.addColorStop(0.4, rgba(c, 0.28));
    rg.addColorStop(0.7, rgba(c, 0.08));
    rg.addColorStop(1, rgba(c, 0));
    x.fillStyle = rg;
    x.fillRect(0, 0, r * 2, r);
    return cv;
  });
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
  const key = [g.w, g.h, g.sc.toFixed(4), layout.lo, layout.hi, layout.width.toFixed(2), css(g.white), css(g.black), css(g.border), g.labels].join('|');
  const st = lru(staticCache, key, 4, () => buildStatic(layout, g));

  const n = layout.hi - layout.lo + 1;
  const colors: (RGB | null)[] = new Array(n);
  const spans: [number, number][] = [];
  let anyBlackPressed = false;
  for (let m = layout.lo; m <= layout.hi; m++) {
    const k = layout.keys[m];
    const c = k ? keyColor(m) : null;
    colors[m - layout.lo] = c;
    if (c && k) {
      if (k.black) {
        anyBlackPressed = true;
        spans.push([Math.floor(k.x - g.shadowL), Math.ceil(k.x + k.w + g.shadowR)]);
      } else spans.push([Math.floor(k.x - 1), Math.ceil(k.x + k.w + 1)]);
    }
  }

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // soft hit-line highlight just above the keyboard
  if (o.hitLine) {
    const hh = 16 * g.sc;
    const hg = ctx.createLinearGradient(0, top - hh, 0, top);
    hg.addColorStop(0, 'rgba(255,255,255,0)');
    hg.addColorStop(1, 'rgba(255,255,255,0.12)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, top - hh, g.w, hh);
  }

  ctx.translate(0, top);
  ctx.drawImage(st.full, 0, 0);

  if (spans.length) {
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([Math.max(0, s[0]), s[1]]);
    }
    const y0 = g.felt;
    const hh = g.h - g.felt;
    for (const span of merged) {
      const a = span[0];
      const b = Math.min(g.w, span[1]);
      if (b <= a) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(a, y0, b - a, hh);
      ctx.clip();
      // 1) resting ivories, 2) pressed ivories
      ctx.drawImage(st.whites, a, y0, b - a, hh, a, y0, b - a, hh);
      for (let m = layout.lo; m <= layout.hi; m++) {
        const k = layout.keys[m];
        const c = colors[m - layout.lo];
        if (c && k && !k.black && k.x < b && k.x + k.w > a) drawWhiteKey(ctx, g, m, k.x, k.w, c);
      }
      // 3) resting black keys, except where a pressed black key (and its old shadow) lives
      if (anyBlackPressed) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(a, y0, b - a, hh);
        for (let m = layout.lo; m <= layout.hi; m++) {
          const k = layout.keys[m];
          if (!k || !k.black || !colors[m - layout.lo]) continue;
          const l = Math.floor(k.x - g.shadowL);
          const r = Math.ceil(k.x + k.w + g.shadowR);
          if (r > a && l < b) ctx.rect(l, y0, r - l, hh);
        }
        ctx.clip('evenodd');
        ctx.drawImage(st.blacks, a, y0, b - a, hh, a, y0, b - a, hh);
        ctx.restore();
        // 4) pressed black keys
        for (let m = layout.lo; m <= layout.hi; m++) {
          const k = layout.keys[m];
          const c = colors[m - layout.lo];
          if (c && k && k.black && k.x - g.shadowL < b && k.x + k.w + g.shadowR > a) drawBlackKey(ctx, g, k.x, k.w, c);
        }
      } else {
        ctx.drawImage(st.blacks, a, y0, b - a, hh, a, y0, b - a, hh);
      }
      drawFeltShadow(ctx, g, a, b);
      ctx.restore();
    }

    // gentle additive light pooled where each pressed key meets the felt
    if (o.glow > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, g.w, g.h);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const r = Math.max(8, Math.round(Math.max(layout.whiteW * 1.5, 22 * g.ks)));
      const a = Math.min(1, o.glow) * (g.darkTheme ? 1 : 0.85);
      ctx.globalAlpha = a;
      for (let m = layout.lo; m <= layout.hi; m++) {
        const c = colors[m - layout.lo];
        const k = layout.keys[m];
        if (!c || !k) continue;
        const cx = k.x + k.w / 2;
        const rr = k.black ? Math.round(r * 0.8) : r;
        ctx.drawImage(bloomSprite(c, rr), cx - rr, g.felt - rr * 0.12, rr * 2, rr);
      }
      ctx.restore();
    }
  }

  if (o.hitLine) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(0, 0, g.w, Math.max(1, Math.round(1.2 * g.sc)));
  }
  ctx.restore();
}
