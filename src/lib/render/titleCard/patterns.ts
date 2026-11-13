/**
 * Letter fills for the title page. All original and procedural (no images shipped):
 *  - "Bouquet": a seamless floral print drawn here (roses, blossoms, asters, florets, leaves on
 *    soft watercolour washes), fully deterministic;
 *  - "Gold" / "Silver": metallic foil gradients;
 *  - the note-decal patterns of decals.ts (marble, galaxy, watercolour, aurora, sakura, stained glass).
 */
import { hash, makeCanvas, type AnyCanvas, type Ctx2D } from '../color';
import { getPatternTile } from '../decals';
import type { FillPatternId } from './types';

const TAU = Math.PI * 2;

const rng = (seed: number) => {
  let i = 0;
  return () => hash(seed, i++);
};
const hexRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (h: string, a: number) => {
  const [r, g, b] = hexRgb(h);
  return `rgba(${r},${g},${b},${a})`;
};
const mixHex = (a: string, b: string, t: number) => {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
};

/** Calls fn for every copy of a shape at (x, y) with radius r that touches the S×S torus tile. */
function wrap(S: number, x: number, y: number, r: number, fn: (x: number, y: number) => void) {
  for (let dx = -S; dx <= S; dx += S)
    for (let dy = -S; dy <= S; dy += S) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx + r < 0 || xx - r > S || yy + r < 0 || yy - r > S) continue;
      fn(xx, yy);
    }
}

interface Pal {
  deep: string;
  mid: string;
  light: string;
  ctr: string;
}
const FLOWER_PAL: Pal[] = [
  { deep: '#7c0f45', mid: '#c8226d', light: '#f6a9cb', ctr: '#4a0828' }, // deep magenta
  { deep: '#55165f', mid: '#9a3fa8', light: '#e2b5ec', ctr: '#2c0a33' }, // plum
  { deep: '#8e1650', mid: '#d6397e', light: '#f9c6dc', ctr: '#5a0d33' }, // magenta
  { deep: '#6b2a96', mid: '#a75fcf', light: '#e8d0f5', ctr: '#3b1258' }, // orchid
  { deep: '#43308f', mid: '#7b68cf', light: '#d6d0f6', ctr: '#241a5c' }, // violet
  { deep: '#a3245a', mid: '#e8668f', light: '#fde0ea', ctr: '#6a1238' }, // rose pink
  { deep: '#2f3f8f', mid: '#6d82d6', light: '#d3dcf8', ctr: '#1a2463' }, // periwinkle
  { deep: '#7a1e6e', mid: '#c04ba8', light: '#f3cdea', ctr: '#4a0f42' }, // fuchsia-plum
];
const LEAF_PAL = ['#8b87a6', '#a49cc2', '#7f8fa0', '#9aa7a0', '#b4a8c9'];
const WASH = ['#e2c4ef', '#f3c1d8', '#cfc8f2', '#eec9e0'];

function petalPath(ctx: Ctx2D, r: number, w: number, notch: boolean) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(r * 0.3, -r * w * 0.9, r * 0.85, -r * w, r, notch ? -r * 0.08 : 0);
  if (notch) ctx.quadraticCurveTo(r * 0.9, 0, r, r * 0.08);
  ctx.bezierCurveTo(r * 0.85, r * w, r * 0.3, r * w * 0.9, 0, 0);
  ctx.closePath();
}

function drawBlossom(ctx: Ctx2D, r: number, rot: number, pal: Pal, R: () => number, n: number) {
  for (let layer = 0; layer < 2; layer++) {
    const rr = layer === 0 ? r : r * 0.62;
    const off = layer === 0 ? 0 : Math.PI / n;
    for (let k = 0; k < n; k++) {
      ctx.save();
      ctx.rotate(rot + off + (k * TAU) / n + (R() - 0.5) * 0.15);
      const pr = rr * (0.9 + R() * 0.18);
      const g = ctx.createLinearGradient(0, 0, pr, 0);
      g.addColorStop(0, layer ? pal.deep : pal.mid);
      g.addColorStop(0.55, layer ? pal.mid : mixHex(pal.mid, pal.light, 0.5));
      g.addColorStop(1, pal.light);
      petalPath(ctx, pr, layer ? 0.42 : 0.5, layer === 0);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = rgba(pal.deep, 0.35);
      ctx.lineWidth = r * 0.018;
      ctx.stroke();
      ctx.strokeStyle = rgba(pal.deep, 0.22);
      ctx.lineWidth = r * 0.012;
      ctx.beginPath();
      ctx.moveTo(pr * 0.12, 0);
      ctx.lineTo(pr * 0.75, 0);
      ctx.moveTo(pr * 0.25, 0);
      ctx.lineTo(pr * 0.6, -pr * 0.14);
      ctx.moveTo(pr * 0.25, 0);
      ctx.lineTo(pr * 0.6, pr * 0.14);
      ctx.stroke();
      ctx.restore();
    }
  }
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.2);
  cg.addColorStop(0, '#fff1c9');
  cg.addColorStop(0.5, '#e8b64f');
  cg.addColorStop(1, pal.ctr);
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.17, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff4d6';
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU + rot;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r * 0.24, Math.sin(a) * r * 0.24, r * 0.025, 0, TAU);
    ctx.fill();
  }
}

function drawRose(ctx: Ctx2D, r: number, rot: number, pal: Pal, R: () => number) {
  const rings = [
    { n: 7, d: 0.5, rx: 0.52, ry: 0.42, c0: pal.mid, c1: pal.light },
    { n: 6, d: 0.33, rx: 0.4, ry: 0.32, c0: mixHex(pal.deep, pal.mid, 0.5), c1: mixHex(pal.mid, pal.light, 0.4) },
    { n: 5, d: 0.18, rx: 0.28, ry: 0.22, c0: pal.deep, c1: pal.mid },
  ];
  rings.forEach((rg, li) => {
    for (let k = 0; k < rg.n; k++) {
      const a = rot + (k * TAU) / rg.n + li * 0.45 + (R() - 0.5) * 0.2;
      ctx.save();
      ctx.rotate(a);
      ctx.translate(r * rg.d, 0);
      const g = ctx.createRadialGradient(-r * rg.rx * 0.6, 0, 0, -r * rg.rx * 0.2, 0, r * rg.rx * 1.1);
      g.addColorStop(0, rg.c0);
      g.addColorStop(1, rg.c1);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * rg.rx, r * rg.ry, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = r * 0.022;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * rg.rx * 0.96, r * rg.ry * 0.96, 0, -1.1, 1.1);
      ctx.stroke();
      ctx.strokeStyle = rgba(pal.deep, 0.3);
      ctx.lineWidth = r * 0.014;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * rg.rx, r * rg.ry, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  });
  ctx.strokeStyle = rgba(pal.ctr, 0.85);
  ctx.lineWidth = r * 0.03;
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const a = rot + i * 0.32;
    const rad = r * 0.02 + i * r * 0.0035;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
}

function drawAster(ctx: Ctx2D, r: number, rot: number, pal: Pal, R: () => number) {
  const n = 13 + Math.floor(R() * 4);
  for (let k = 0; k < n; k++) {
    ctx.save();
    ctx.rotate(rot + (k * TAU) / n);
    const pr = r * (0.85 + R() * 0.2);
    const g = ctx.createLinearGradient(0, 0, pr, 0);
    g.addColorStop(0, pal.mid);
    g.addColorStop(1, pal.light);
    petalPath(ctx, pr, 0.17, false);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = rgba(pal.deep, 0.3);
    ctx.lineWidth = r * 0.012;
    ctx.stroke();
    ctx.restore();
  }
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.22);
  cg.addColorStop(0, '#ffe49a');
  cg.addColorStop(1, '#b86b1c');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.2, 0, TAU);
  ctx.fill();
}

function drawFloret(ctx: Ctx2D, r: number, rot: number, pal: Pal) {
  for (let k = 0; k < 4; k++) {
    ctx.save();
    ctx.rotate(rot + (k * TAU) / 4);
    ctx.fillStyle = k % 2 ? pal.mid : mixHex(pal.mid, pal.light, 0.4);
    ctx.beginPath();
    ctx.ellipse(r * 0.5, 0, r * 0.5, r * 0.36, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.18, 0, TAU);
  ctx.fill();
}

function drawLeaf(ctx: Ctx2D, len: number, wid: number, col: string) {
  const g = ctx.createLinearGradient(0, 0, len, 0);
  g.addColorStop(0, mixHex(col, '#3a3450', 0.35));
  g.addColorStop(1, mixHex(col, '#ffffff', 0.35));
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, -wid, len, 0);
  ctx.quadraticCurveTo(len * 0.45, wid, 0, 0);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,30,60,0.25)';
  ctx.lineWidth = Math.max(1, wid * 0.08);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(len * 0.05, 0);
  ctx.quadraticCurveTo(len * 0.5, -wid * 0.1, len * 0.92, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = Math.max(1, wid * 0.07);
  ctx.stroke();
}

/** Seamless S×S floral print. Deterministic: the same pixels on every run and device. */
export function drawBouquet(ctx: Ctx2D, S: number, seed = 11): void {
  const R = rng(seed);
  // a light lilac ground (never plain white inside the letters), covered by washes and flowers
  ctx.fillStyle = '#efdcef';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 22; i++) {
    const x = R() * S;
    const y = R() * S;
    const r = (0.1 + R() * 0.2) * S;
    const col = WASH[Math.floor(R() * WASH.length)];
    wrap(S, x, y, r, (xx, yy) => {
      const g = ctx.createRadialGradient(xx, yy, 0, xx, yy, r);
      g.addColorStop(0, rgba(col, 0.85));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(xx, yy, r, 0, TAU);
      ctx.fill();
    });
  }
  // variable-radius dart throwing on a torus, large flowers first
  const items: { x: number; y: number; r: number }[] = [];
  const tdist = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    let dx = Math.abs(a.x - b.x);
    let dy = Math.abs(a.y - b.y);
    dx = Math.min(dx, S - dx);
    dy = Math.min(dy, S - dy);
    return Math.hypot(dx, dy);
  };
  const tiers = [
    { count: 16, r0: 0.06, r1: 0.085 },
    { count: 34, r0: 0.036, r1: 0.055 },
    { count: 110, r0: 0.014, r1: 0.028 },
  ];
  for (const t of tiers) {
    let placed = 0;
    for (let tries = 0; tries < 3000 && placed < t.count; tries++) {
      const it = { x: R() * S, y: R() * S, r: (t.r0 + R() * (t.r1 - t.r0)) * S };
      if (items.every((o) => tdist(o, it) > (o.r + it.r) * 0.66)) {
        items.push(it);
        placed++;
      }
    }
  }
  for (const it of items) {
    if (it.r < 0.04 * S) continue;
    const n = 2 + Math.floor(R() * 3);
    const a0 = R() * TAU;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k * TAU) / n + (R() - 0.5) * 0.8;
      const len = it.r * (1.25 + R() * 0.5);
      const wid = len * (0.2 + R() * 0.1);
      const col = LEAF_PAL[Math.floor(R() * LEAF_PAL.length)];
      wrap(S, it.x, it.y, it.r * 2, (xx, yy) => {
        ctx.save();
        ctx.translate(xx, yy);
        ctx.rotate(a);
        ctx.translate(it.r * 0.4, 0);
        drawLeaf(ctx, len, wid, col);
        ctx.restore();
      });
    }
  }
  for (let i = 0; i < 160; i++) {
    const x = R() * S;
    const y = R() * S;
    const rr = S * (0.004 + R() * 0.006);
    const pal = FLOWER_PAL[Math.floor(R() * FLOWER_PAL.length)];
    const fill = R() < 0.5 ? pal.mid : pal.light;
    wrap(S, x, y, rr * 2, (xx, yy) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(xx, yy, rr, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(pal.deep, 0.4);
      ctx.lineWidth = rr * 0.3;
      ctx.stroke();
    });
  }
  items.forEach((it, idx) => {
    const pal = FLOWER_PAL[Math.floor(R() * FLOWER_PAL.length)];
    const rot = R() * TAU;
    const kind = it.r > 0.07 * S ? (R() < 0.5 ? 'rose' : 'blossom') : it.r > 0.04 * S ? (R() < 0.5 ? 'blossom' : 'aster') : 'floret';
    const nPetal = 5 + (R() < 0.3 ? 1 : 0);
    wrap(S, it.x, it.y, it.r * 1.15, (xx, yy) => {
      const RR = rng(seed * 100 + idx); // the same petals on every wrapped copy
      ctx.save();
      ctx.translate(xx, yy);
      const sh = ctx.createRadialGradient(0, 0, it.r * 0.6, 0, 0, it.r * 1.15);
      sh.addColorStop(0, 'rgba(60,30,80,0.18)');
      sh.addColorStop(1, 'rgba(60,30,80,0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.arc(0, 0, it.r * 1.15, 0, TAU);
      ctx.fill();
      if (kind === 'rose') drawRose(ctx, it.r, rot, pal, RR);
      else if (kind === 'blossom') drawBlossom(ctx, it.r, rot, pal, RR, nPetal);
      else if (kind === 'aster') drawAster(ctx, it.r, rot, pal, RR);
      else drawFloret(ctx, it.r, rot, pal);
      ctx.restore();
    });
  });
}

export const GOLD_STOPS: [number, string][] = [
  [0, '#8a6424'],
  [0.22, '#e9c873'],
  [0.42, '#fff1c4'],
  [0.6, '#c9973d'],
  [0.8, '#f2d68a'],
  [1, '#94692a'],
];
export const SILVER_STOPS: [number, string][] = [
  [0, '#6d7078'],
  [0.22, '#e9ebf0'],
  [0.42, '#ffffff'],
  [0.6, '#9a9ea8'],
  [0.8, '#dfe2e8'],
  [1, '#737780'],
];

export interface PatternInfo {
  id: FillPatternId;
  name: string;
  /** metallic gradient instead of a tile */
  stops?: [number, string][];
  /** pattern id in decals.ts */
  decal?: string;
  /**
   * Tone changes for letters (the note-decal tiles are made for small, bright notes): `lift`
   * raises the darkest tones (screen with white), `lo` / `hi` stretch the lightness range to
   * lo..hi, `sat` boosts the colour.
   */
  tone?: { lift?: number; lo?: number; hi?: number; sat?: number };
}

export const FILL_PATTERNS: PatternInfo[] = [
  { id: 'bouquet', name: 'Flowers' },
  { id: 'gold', name: 'Gold', stops: GOLD_STOPS },
  { id: 'silver', name: 'Silver', stops: SILVER_STOPS },
  { id: 'marble', name: 'Marble', decal: 'marble', tone: { lo: 0.22, hi: 1, sat: 1.5 } },
  { id: 'galaxy', name: 'Galaxy', decal: 'galaxy', tone: { lift: 0.34, sat: 1.15 } },
  { id: 'watercolor', name: 'Watercolor', decal: 'watercolor', tone: { lo: 0.3, hi: 1, sat: 1.9 } },
  { id: 'aurora', name: 'Aurora', decal: 'aurora', tone: { lift: 0.4, sat: 1.2 } },
  { id: 'sakura', name: 'Sakura', decal: 'sakura', tone: { lo: 0.32, hi: 1, sat: 2 } },
  { id: 'stained-glass', name: 'Stained glass', decal: 'stained-glass', tone: { lift: 0.12 } },
];

export function patternInfo(id: FillPatternId): PatternInfo {
  return FILL_PATTERNS.find((p) => p.id === id) ?? FILL_PATTERNS[0];
}

const tiles = new Map<string, AnyCanvas>();

/** Tile sizes made for letters: the next power of two of the size on screen, 128..1024. */
export function tileSizeFor(px: number): number {
  let s = 128;
  while (s < px && s < 1024) s *= 2;
  return s;
}

/** Applies a pattern's tone changes in place (see PatternInfo.tone). */
export function toneTile(ctx: Ctx2D, S: number, tone: NonNullable<PatternInfo['tone']>): void {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  const lift = tone.lift ?? 0;
  const sat = tone.sat ?? 1;
  let lo = 0;
  let hi = 1;
  if (tone.lo !== undefined || tone.hi !== undefined) {
    // stretch the tile's own lightness range (2nd..98th percentile) to lo..hi
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++;
    const n = d.length / 4;
    let acc = 0;
    let p2 = 0;
    let p98 = 255;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc < n * 0.02) p2 = v;
      if (acc <= n * 0.98) p98 = v;
    }
    lo = p2 / 255;
    hi = Math.max(lo + 0.05, p98 / 255);
  }
  const tlo = tone.lo ?? lo;
  const thi = tone.hi ?? hi;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255;
    let g = d[i + 1] / 255;
    let b = d[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // lightness stretch (the colour offsets are kept), then saturation around the new lightness
    const l2 = tlo + ((Math.min(hi, Math.max(lo, l)) - lo) / (hi - lo)) * (thi - tlo);
    r = l2 + (r - l) * sat;
    g = l2 + (g - l) * sat;
    b = l2 + (b - l) * sat;
    if (lift) {
      r = 1 - (1 - r) * (1 - lift);
      g = 1 - (1 - g) * (1 - lift);
      b = 1 - (1 - b) * (1 - lift);
    }
    d[i] = Math.round(Math.min(1, Math.max(0, r)) * 255);
    d[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
    d[i + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
  }
  ctx.putImageData(img, 0, 0);
}

/** Seamless tile for a pattern fill (null for the gradient fills), toned for letters. Cached. */
export function getFillTile(id: FillPatternId, size = 1024): AnyCanvas | null {
  const info = patternInfo(id);
  if (info.stops) return null;
  const key = `${id}@${size}`;
  let t = tiles.get(key);
  if (!t) {
    const src = info.decal ? getPatternTile(info.decal, size) : null;
    if (info.decal && !src) return null;
    t = makeCanvas(size, size);
    const ctx = t.getContext('2d') as Ctx2D | null;
    if (!ctx) return null;
    if (src) {
      ctx.drawImage(src as CanvasImageSource, 0, 0);
      if (info.tone) toneTile(ctx, size, info.tone);
    } else drawBouquet(ctx, size);
    tiles.set(key, t);
  }
  return t;
}
