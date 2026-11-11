/**
 * Note decals: an image or an original procedural pattern painted inside every note.
 *
 * CONTRACT (used by renderer.ts — keep these signatures):
 *  - DECAL_PATTERNS: built-in, ORIGINAL patterns (procedurally drawn, deterministic, no
 *    external assets, no copied artwork). Each draws one seamless tile.
 *  - getPatternTile(id, size): returns a cached seamless tile canvas for a pattern.
 *  - paintNoteDecal(ctx, rect, radius, p): fills the note's rounded rect with the decal.
 *
 * Everything here is Canvas 2D only, so it runs on the main thread and in export workers
 * (OffscreenCanvas). All randomness is seeded through `hash`, so tiles are identical on
 * every run, every machine and every frame.
 */
import type { DecalSettings } from './settings';
import { hash, makeCanvas, rgba, mix, roundRect, WHITE, type AnyCanvas, type Ctx2D, type RGB } from './color';

export interface DecalPattern {
  id: string;
  name: string;
  /** Draw one seamless tile of `size`×`size` px. Must be deterministic. */
  draw(ctx: Ctx2D, size: number): void;
}

// ---------------------------------------------------------------------------------------
// Small deterministic toolkit
// ---------------------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** Seeded random stream in [0, 1). */
function rng(seed: number): () => number {
  let i = 0;
  return () => hash(seed, i++);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/**
 * Call `fn` at (x, y) and at every ±size copy that could still reach into the tile,
 * so an element of radius `r` that crosses an edge continues on the opposite side.
 */
function wrap(size: number, x: number, y: number, r: number, fn: (x: number, y: number) => void): void {
  for (let dx = -size; dx <= size; dx += size) {
    const xx = x + dx;
    if (xx + r < 0 || xx - r > size) continue;
    for (let dy = -size; dy <= size; dy += size) {
      const yy = y + dy;
      if (yy + r < 0 || yy - r > size) continue;
      fn(xx, yy);
    }
  }
}

/** Run `fn` nine times translated by every ±size offset (for long strokes like branches). */
function wrapAll(ctx: Ctx2D, size: number, fn: () => void): void {
  for (let dx = -size; dx <= size; dx += size) {
    for (let dy = -size; dy <= size; dy += size) {
      ctx.save();
      ctx.translate(dx, dy);
      fn();
      ctx.restore();
    }
  }
}

/** Periodic value noise: lattice wraps every `px` × `py` cells, so it tiles seamlessly. */
function noise(seed: number, x: number, y: number, px: number, py: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const s = seed * 131 + px * 17 + py * 7;
  const v00 = hash(s, x0 + y0 * 4099);
  const v10 = hash(s, x1 + y0 * 4099);
  const v01 = hash(s, x0 + y1 * 4099);
  const v11 = hash(s, x1 + y1 * 4099);
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

/** Fractal (fBm) periodic noise in [0, 1]. x, y in lattice units of the first octave. */
function fbm(seed: number, x: number, y: number, px: number, py: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let tot = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(seed + o * 1013, x, y, px, py);
    tot += amp;
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / tot;
}

/** Fill the tile pixel-by-pixel. `fn` writes r, g, b (0..255) into `out`. */
function pixels(ctx: Ctx2D, size: number, fn: (x: number, y: number, out: number[]) => void): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const out = [0, 0, 0];
  let i = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x, y, out);
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = 255;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Multiply existing pixels by a subtle paper/canvas grain. */
function grain(ctx: Ctx2D, size: number, seed: number, amount: number): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const f = 64 / size;
  let i = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(seed, x * f, y * f, 64, 64, 2) - 0.5;
      const fine = hash(seed + 9, ((x & 511) + (y & 511) * 512)) - 0.5;
      const k = 1 + amount * (n * 0.8 + fine * 0.5);
      d[i] = Math.min(255, d[i] * k);
      d[i + 1] = Math.min(255, d[i + 1] * k);
      d[i + 2] = Math.min(255, d[i + 2] * k);
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Soft round wash (a watercolour-ish blot) — radial gradient that fades to nothing. */
function wash(ctx: Ctx2D, size: number, x: number, y: number, r: number, c: RGB, a: number): void {
  wrap(size, x, y, r, (xx, yy) => {
    const g = ctx.createRadialGradient(xx, yy, 0, xx, yy, r);
    g.addColorStop(0, rgba(c, a));
    g.addColorStop(0.6, rgba(c, a * 0.45));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(xx - r, yy - r, r * 2, r * 2);
  });
}

/** Irregular blob outline (for washes, glass, confetti…). */
function blobPath(ctx: Ctx2D, x: number, y: number, r: number, seed: number, rough = 0.22, pts = 36): void {
  const p1 = hash(seed, 1) * TAU;
  const p2 = hash(seed, 2) * TAU;
  const p3 = hash(seed, 3) * TAU;
  ctx.beginPath();
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * TAU;
    const k =
      1 +
      rough *
        (0.5 * Math.sin(a * 2 + p1) + 0.28 * Math.sin(a * 3 + p2) + 0.14 * Math.sin(a * 5 + p3) + 0.07 * Math.sin(a * 9 + p1 * 2) + 0.04 * Math.sin(a * 14 + p2 * 3));
    const px = x + Math.cos(a) * r * k;
    const py = y + Math.sin(a) * r * k;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------------------
// Botanical primitives
// ---------------------------------------------------------------------------------------

/** One petal pointing up (−y) from the origin. `hw` = half width. */
function petalPath(ctx: Ctx2D, len: number, hw: number, notch = 0, pinch = 0.5): void {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-hw * pinch, -len * 0.18, -hw * 1.05, -len * 0.6, -hw * 0.45, -len * 0.94);
  if (notch > 0) {
    ctx.quadraticCurveTo(-hw * 0.2, -len * 1.04, 0, -len * (1 - notch));
    ctx.quadraticCurveTo(hw * 0.2, -len * 1.04, hw * 0.45, -len * 0.94);
  } else {
    ctx.quadraticCurveTo(0, -len * 1.1, hw * 0.45, -len * 0.94);
  }
  ctx.bezierCurveTo(hw * 1.05, -len * 0.6, hw * pinch, -len * 0.18, 0, 0);
  ctx.closePath();
}

interface FlowerPalette {
  deep: string;
  mid: string;
  light: string;
  center: string;
  stamen: string;
}

const MEADOW_PALETTES: FlowerPalette[] = [
  // rose / raspberry
  { deep: '#8f1846', mid: '#cf4c7a', light: '#f5b4c8', center: '#4a0c2c', stamen: '#ffd9a0' },
  // lavender
  { deep: '#5a45a6', mid: '#9785de', light: '#ddd4f8', center: '#2b2160', stamen: '#fff1c2' },
  // periwinkle
  { deep: '#3446a8', mid: '#7586e2', light: '#c9d1f8', center: '#1b2163', stamen: '#ffe7a3' },
  // plum
  { deep: '#3e0f37', mid: '#7d2a66', light: '#c27aac', center: '#f0c25e', stamen: '#fff0c4' },
  // coral
  { deep: '#a92a35', mid: '#e0645a', light: '#f8bba9', center: '#5c1424', stamen: '#ffd27a' },
  // twilight pansy (deep indigo with a golden eye)
  { deep: '#17182e', mid: '#373a6c', light: '#7e83c0', center: '#e9c25a', stamen: '#fff2bf' },
];

/**
 * A softly shaded flower head. `layers` = 1 for single blooms (anemone / cosmos),
 * 2 for fuller double blooms. Every petal gets a radial gradient plus a few translucent
 * "brush dabs" clipped to its shape, so the bloom reads as painted rather than vector.
 */
function flower(
  ctx: Ctx2D,
  x: number,
  y: number,
  R: number,
  rot: number,
  pal: FlowerPalette,
  n: number,
  notch: number,
  seed: number,
  layers = 2,
): void {
  const r = rng(seed);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  // pigment bleeding into the paper around the bloom
  const halo = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.3);
  halo.addColorStop(0, rgba(hex(pal.light), 0.4));
  halo.addColorStop(1, rgba(hex(pal.light), 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.3, 0, TAU);
  ctx.fill();

  const deep = hex(pal.deep);
  const midC = hex(pal.mid);
  const light = hex(pal.light);
  const L = [
    { len: R, hw: R * (layers === 1 ? 0.6 : 0.5) * (0.9 + 0.25 * r()), off: 0, alpha: 0.86, outer: pal.light },
    { len: R * 0.7, hw: R * (0.36 + 0.1 * r()), off: Math.PI / n, alpha: 0.93, outer: pal.light },
  ].slice(0, layers);
  for (const lay of L) {
    const g = ctx.createRadialGradient(0, 0, R * 0.04, 0, 0, lay.len);
    g.addColorStop(0, pal.deep);
    g.addColorStop(0.45, pal.mid);
    g.addColorStop(1, lay.outer);
    for (let i = 0; i < n; i++) {
      ctx.save();
      ctx.rotate(lay.off + (i / n) * TAU + (r() - 0.5) * 0.3);
      const len = lay.len * (0.85 + 0.25 * r());
      const hw = lay.hw * (0.85 + 0.3 * r());
      petalPath(ctx, len, hw, notch);
      ctx.globalAlpha = lay.alpha;
      ctx.fillStyle = g;
      ctx.fill();
      // painterly dabs inside the petal
      ctx.save();
      ctx.clip();
      for (let d = 0; d < 5; d++) {
        const dc = d % 2 ? mix(light, WHITE, 0.4) : mix(deep, midC, 0.5);
        ctx.globalAlpha = 0.12 + 0.12 * r();
        ctx.fillStyle = rgba(dc, 1);
        ctx.beginPath();
        ctx.ellipse((r() - 0.5) * hw, -len * (0.25 + 0.65 * r()), hw * (0.25 + 0.35 * r()), len * (0.12 + 0.18 * r()), (r() - 0.5) * 0.8, 0, TAU);
        ctx.fill();
      }
      // pale, sunlit tip
      const tg = ctx.createLinearGradient(0, -len * 0.55, 0, -len);
      tg.addColorStop(0, 'rgba(255,255,255,0)');
      tg.addColorStop(1, 'rgba(255,255,255,0.3)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = tg;
      ctx.fillRect(-hw * 1.2, -len * 1.1, hw * 2.4, len * 0.6);
      ctx.restore();
      // soft rim
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = Math.max(0.7, R * 0.022);
      ctx.strokeStyle = pal.deep;
      ctx.stroke();
      // fine veins running out from the base
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = Math.max(0.5, R * 0.016);
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(k * hw * 0.06, -len * 0.12);
        ctx.quadraticCurveTo(k * hw * 0.38, -len * 0.45, k * hw * 0.3, -len * (0.6 + 0.12 * r()));
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  // eye
  ctx.globalAlpha = 1;
  const cr = R * (layers === 1 ? 0.2 : 0.15) * (0.9 + 0.3 * r());
  const cg = ctx.createRadialGradient(-cr * 0.3, -cr * 0.3, 0, 0, 0, cr * 1.2);
  cg.addColorStop(0, rgba(mix(hex(pal.center), WHITE, 0.35), 1));
  cg.addColorStop(1, pal.center);
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(0, 0, cr, 0, TAU);
  ctx.fill();
  // stamens
  const sc = Math.round(10 + r() * 8);
  ctx.fillStyle = pal.stamen;
  ctx.strokeStyle = pal.center;
  ctx.lineWidth = Math.max(0.5, R * 0.012);
  for (let i = 0; i < sc; i++) {
    const a = (i / sc) * TAU + r() * 0.3;
    const d = cr * (1.1 + r() * 0.6);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * cr * 0.6, Math.sin(a) * cr * 0.6);
    ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.8, R * 0.032), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** A nodding bell flower (side view) on a short curved stem. */
function bell(ctx: Ctx2D, x: number, y: number, R: number, rot: number, pal: FlowerPalette): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.strokeStyle = '#5d7a66';
  ctx.lineWidth = Math.max(0.8, R * 0.08);
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(0, -R * 0.9);
  ctx.quadraticCurveTo(R * 0.5, -R * 1.6, R * 0.2, -R * 2.3);
  ctx.stroke();
  // cup with three flared lobes
  ctx.beginPath();
  ctx.moveTo(-R * 0.35, -R * 0.85);
  ctx.bezierCurveTo(-R * 0.75, -R * 0.4, -R * 0.75, R * 0.2, -R * 0.95, R * 0.55);
  ctx.quadraticCurveTo(-R * 0.6, R * 0.35, -R * 0.4, R * 0.7);
  ctx.quadraticCurveTo(-R * 0.1, R * 0.4, 0, R * 0.78);
  ctx.quadraticCurveTo(R * 0.1, R * 0.4, R * 0.4, R * 0.7);
  ctx.quadraticCurveTo(R * 0.6, R * 0.35, R * 0.95, R * 0.55);
  ctx.bezierCurveTo(R * 0.75, R * 0.2, R * 0.75, -R * 0.4, R * 0.35, -R * 0.85);
  ctx.closePath();
  const g = ctx.createLinearGradient(-R, 0, R, 0);
  g.addColorStop(0, pal.deep);
  g.addColorStop(0.45, pal.mid);
  g.addColorStop(0.75, pal.light);
  g.addColorStop(1, pal.mid);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = pal.deep;
  ctx.lineWidth = Math.max(0.6, R * 0.04);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-R * 0.15, -R * 0.6);
  ctx.quadraticCurveTo(-R * 0.25, 0, -R * 0.15, R * 0.5);
  ctx.moveTo(R * 0.2, -R * 0.6);
  ctx.quadraticCurveTo(R * 0.3, 0, R * 0.2, R * 0.5);
  ctx.stroke();
  // sepals
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = '#5d7a66';
  for (const sx of [-1, 0, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx * R * 0.12, -R * 0.95);
    ctx.lineTo(sx * R * 0.45, -R * 0.55);
    ctx.lineTo(sx * R * 0.05, -R * 0.75);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Leaf pointing up (−y) from the origin with a gradient and a midrib. */
function leaf(ctx: Ctx2D, x: number, y: number, len: number, hw: number, rot: number, c1: string, c2: string, veins = true): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(hw * 1.1, -len * 0.25, hw * 0.9, -len * 0.75, 0, -len);
  ctx.bezierCurveTo(-hw * 0.6, -len * 0.78, -hw * 1.2, -len * 0.3, 0, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(-hw, 0, hw, -len);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.globalAlpha = 0.92;
  ctx.fill();
  if (veins) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#f4f7ee';
    ctx.lineWidth = Math.max(0.6, hw * 0.08);
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.05);
    ctx.quadraticCurveTo(hw * 0.12, -len * 0.5, 0, -len * 0.92);
    ctx.stroke();
    ctx.globalAlpha = 0.22;
    for (let i = 1; i <= 3; i++) {
      const t = i / 4.2;
      ctx.beginPath();
      ctx.moveTo(hw * 0.05, -len * t);
      ctx.lineTo(hw * 0.6, -len * (t + 0.14));
      ctx.moveTo(0, -len * (t + 0.04));
      ctx.lineTo(-hw * 0.6, -len * (t + 0.16));
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Five round-petalled little filler blossom. */
function blossom(ctx: Ctx2D, x: number, y: number, r: number, rot: number, petal: string, eye: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = petal;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    ctx.globalAlpha = 0.88;
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.5, r * 0.4, a, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = eye;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.24, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------

function drawMeadow(ctx: Ctx2D, S: number): void {
  const k = S / 512;
  const r = rng(1201);
  // pale cream ground with blush and lilac washes
  ctx.fillStyle = '#fbf4f0';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 16; i++) {
    const c = [hex('#f5d6e1'), hex('#e3dbf8'), hex('#fde8dc'), hex('#dbe4fa')][i % 4];
    wash(ctx, S, r() * S, r() * S, (60 + r() * 110) * k, c, 0.6);
  }
  const leafCols: [string, string][] = [
    ['#5f7f68', '#a9c2a3'],
    ['#3d5248', '#7d9688'],
    ['#46516c', '#8f9aba'],
    ['#6c8a5c', '#bcd0a2'],
    ['#2e3a3c', '#66767a'],
  ];
  // leafy sprays (back layer): a curved stem with paired leaves
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = (60 + r() * 50) * k;
    const a = r() * TAU;
    const bend = (r() - 0.5) * 0.9;
    const [c1, c2] = leafCols[Math.floor(r() * leafCols.length)];
    const seed = 3000 + i;
    wrap(S, x, y, len * 1.2, (xx, yy) => {
      const rr = rng(seed);
      ctx.save();
      ctx.translate(xx, yy);
      ctx.rotate(a);
      ctx.strokeStyle = c1;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * bend, -len * 0.5, 0, -len);
      ctx.stroke();
      for (let j = 1; j <= 4; j++) {
        const t = j / 4.4;
        const px = 2 * (1 - t) * t * len * bend;
        const py = -len * t;
        const ll = (18 + rr() * 14) * k * (1.15 - t * 0.4);
        leaf(ctx, px, py, ll, ll * 0.32, -0.9 - rr() * 0.4, c1, c2, ll > 16 * k);
        leaf(ctx, px, py, ll, ll * 0.32, 0.9 + rr() * 0.4, c1, c2, ll > 16 * k);
      }
      leaf(ctx, 0, -len, 16 * k, 5 * k, 0, c1, c2, false);
      ctx.restore();
    });
  }
  // single large leaves
  for (let i = 0; i < 26; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = (36 + r() * 40) * k;
    const hw = len * (0.24 + r() * 0.1);
    const rot = r() * TAU;
    const [c1, c2] = leafCols[Math.floor(r() * leafCols.length)];
    wrap(S, x, y, len, (xx, yy) => leaf(ctx, xx, yy, len, hw, rot, c1, c2));
  }

  // blooms on a jittered grid so every crop of the tile carries flowers
  const pick = () => {
    const v = r();
    // weights: rose, lavender, periwinkle, plum, coral, twilight
    return MEADOW_PALETTES[v < 0.22 ? 0 : v < 0.42 ? 1 : v < 0.62 ? 2 : v < 0.76 ? 3 : v < 0.87 ? 4 : 5];
  };
  const G = 5;
  const cell = S / G;
  let fi = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const x = (gx + 0.2 + r() * 0.6 + (gy % 2) * 0.5) * cell;
      const y = (gy + 0.2 + r() * 0.6) * cell;
      const big = r() < 0.45;
      const R = (big ? 46 + r() * 16 : 31 + r() * 12) * k;
      const pal = pick();
      const kind = r();
      const seed = 5000 + fi++;
      const rot = r() * TAU;
      if (kind < 0.12 && !big) {
        wrap(S, x % S, y % S, R * 2.4, (xx, yy) => bell(ctx, xx, yy, R * 0.8, rot, pal));
      } else if (kind < 0.45) {
        // single bloom: anemone / cosmos
        const n = kind < 0.3 ? 5 : 8;
        const notch = kind < 0.3 ? 0.04 : 0.12;
        wrap(S, x % S, y % S, R * 1.35, (xx, yy) => flower(ctx, xx, yy, R, rot, pal, n, notch, seed, 1));
      } else {
        const n = kind < 0.75 ? 6 : 7;
        wrap(S, x % S, y % S, R * 1.35, (xx, yy) => flower(ctx, xx, yy, R, rot, pal, n, kind > 0.9 ? 0.08 : 0, seed, 2));
      }
    }
  }
  // overlapping leaves in front of some blooms
  for (let i = 0; i < 12; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = (24 + r() * 22) * k;
    const rot = r() * TAU;
    const [c1, c2] = leafCols[Math.floor(r() * 3)];
    wrap(S, x, y, len, (xx, yy) => leaf(ctx, xx, yy, len, len * 0.28, rot, c1, c2));
  }
  // small blooms and buds filling the gaps
  for (let i = 0; i < 34; i++) {
    const x = r() * S;
    const y = r() * S;
    const R = (9 + r() * 10) * k;
    const pal = pick();
    const rot = r() * TAU;
    const v = r();
    if (v < 0.5) {
      wrap(S, x, y, R, (xx, yy) => blossom(ctx, xx, yy, R, rot, pal.mid, pal.center));
    } else if (v < 0.75) {
      wrap(S, x, y, R * 2, (xx, yy) => bell(ctx, xx, yy, R * 0.9, rot, pal));
    } else {
      const seed = 7000 + i;
      wrap(S, x, y, R * 1.6, (xx, yy) => flower(ctx, xx, yy, R * 1.3, rot, pal, 5, 0, seed, 1));
    }
  }
  grain(ctx, S, 77, 0.07);
}

function drawSakura(ctx: Ctx2D, S: number): void {
  const k = S / 512;
  const r = rng(2203);
  ctx.fillStyle = '#fdf1f3';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 12; i++) {
    const c = [hex('#fbd8e2'), hex('#e3eefc'), hex('#fff4e6')][i % 3];
    wash(ctx, S, r() * S, r() * S, (80 + r() * 120) * k, c, 0.7);
  }
  // branches: random walks drawn in all nine wrapped copies
  interface Seg { x0: number; y0: number; x1: number; y1: number; w: number }
  const segs: Seg[] = [];
  const nodes: { x: number; y: number; w: number }[] = [];
  const grow = (x: number, y: number, a: number, w: number, steps: number, depth: number) => {
    for (let i = 0; i < steps; i++) {
      a += (r() - 0.5) * 0.55;
      const l = (9 + r() * 6) * k;
      const nx = x + Math.cos(a) * l;
      const ny = y + Math.sin(a) * l;
      segs.push({ x0: x, y0: y, x1: nx, y1: ny, w });
      if (i % 2 === 1) nodes.push({ x: nx, y: ny, w });
      x = nx;
      y = ny;
      w = Math.max(1.1 * k, w * 0.93);
      if (depth < 2 && r() < 0.16) grow(x, y, a + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6), w * 0.7, Math.floor(steps * 0.45), depth + 1);
    }
    nodes.push({ x, y, w: 0 });
  };
  grow(-20 * k, 360 * k, -0.35, 7 * k, 30, 0);
  grow(260 * k, 520 * k, -1.9, 6 * k, 22, 0);
  grow(380 * k, 140 * k, 0.4, 5 * k, 20, 0);
  grow(120 * k, 120 * k, 2.6, 4 * k, 14, 1);
  wrapAll(ctx, S, () => {
    ctx.lineCap = 'round';
    for (const s of segs) {
      ctx.strokeStyle = '#4b3a3e';
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,240,240,0.35)';
    for (const s of segs) {
      ctx.lineWidth = s.w * 0.3;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0 - s.w * 0.25);
      ctx.lineTo(s.x1, s.y1 - s.w * 0.25);
      ctx.stroke();
    }
  });
  const sakura = (x: number, y: number, R: number, rot: number, tone: number, seed: number) => {
    const rr = rng(seed);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    const deep = mix(hex('#e46a95'), hex('#c9387a'), tone);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, rgba(deep, 1));
    g.addColorStop(0.45, rgba(mix(deep, WHITE, 0.55), 1));
    g.addColorStop(1, rgba(mix(deep, WHITE, 0.88), 1));
    for (let i = 0; i < 5; i++) {
      ctx.save();
      ctx.rotate((i / 5) * TAU + (rr() - 0.5) * 0.15);
      petalPath(ctx, R * (0.95 + rr() * 0.1), R * 0.52, 0.14, 0.8);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = g;
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(0.6, R * 0.03);
      ctx.strokeStyle = rgba(deep, 1);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#a3245c';
    ctx.lineWidth = Math.max(0.5, R * 0.035);
    ctx.fillStyle = '#ffd36e';
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + rr() * 0.3;
      const d = R * (0.32 + rr() * 0.12);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.7, R * 0.05), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  };
  let si = 0;
  // blossoms where the twigs end and sparsely along the boughs, plus a jittered grid of
  // small clusters so every crop of the tile carries some bloom
  const spots: { x: number; y: number; n: number }[] = [];
  for (const nd of nodes) if (nd.w === 0 || r() < 0.3) spots.push({ x: nd.x, y: nd.y, n: nd.w === 0 ? 3 : 1 });
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) if (r() < 0.75) spots.push({ x: (gx + r()) * S / 4, y: (gy + r()) * S / 4, n: 1 + Math.floor(r() * 3) });
  for (const nd of spots) {
    for (let j = 0; j < nd.n; j++) {
      const R = (15 + r() * 10) * k;
      const x = (((nd.x + (r() - 0.5) * 40 * k) % S) + S) % S;
      const y = (((nd.y + (r() - 0.5) * 40 * k) % S) + S) % S;
      const rot = r() * TAU;
      const tone = r();
      const seed = 900 + si++;
      wrap(S, x, y, R * 1.2, (xx, yy) => sakura(xx, yy, R, rot, tone, seed));
    }
  }
  // drifting single petals
  for (let i = 0; i < 26; i++) {
    const x = r() * S;
    const y = r() * S;
    const R = (7 + r() * 6) * k;
    const rot = r() * TAU;
    wrap(S, x, y, R, (xx, yy) => {
      ctx.save();
      ctx.translate(xx, yy);
      ctx.rotate(rot);
      petalPath(ctx, R * 1.6, R * 0.55, 0.14, 0.8);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#f4a9c2';
      ctx.fill();
      ctx.restore();
    });
  }
  grain(ctx, S, 91, 0.05);
}

function drawWatercolor(ctx: Ctx2D, S: number): void {
  const k = S / 512;
  const r = rng(3307);
  ctx.fillStyle = '#fbf8f2';
  ctx.fillRect(0, 0, S, S);
  const cols = ['#4fb3c8', '#e2789a', '#f1b55a', '#7b74d6', '#7fc49a', '#ef8f6b', '#b17bd0', '#5f9ee0'].map(hex);
  ctx.globalCompositeOperation = 'multiply';
  // washes on a jittered grid (even coverage), each a few glazes with ragged wet edges
  const G = 4;
  let i = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const x = ((gx + 0.2 + r() * 0.6 + (gy % 2) * 0.5) * S) / G;
      const y = ((gy + 0.2 + r() * 0.6) * S) / G;
      const R = (52 + r() * 46) * k;
      const c = cols[(i * 3 + Math.floor(r() * 3)) % cols.length];
      const seed = 40 + i++;
      wrap(S, x % S, y % S, R * 1.5, (xx, yy) => {
        for (let g = 0; g < 3; g++) {
          blobPath(ctx, xx + (hash(seed, g + 10) - 0.5) * 16 * k, yy + (hash(seed, g + 20) - 0.5) * 16 * k, R * (1 - g * 0.18), seed * 7 + g, 0.42, 72);
          const gr = ctx.createRadialGradient(xx - R * 0.25, yy - R * 0.3, R * 0.05, xx, yy, R * 1.25);
          gr.addColorStop(0, rgba(mix(c, WHITE, 0.6), 0.12));
          gr.addColorStop(0.7, rgba(c, 0.2));
          gr.addColorStop(1, rgba(c, 0.32));
          ctx.fillStyle = gr;
          ctx.fill();
        }
        // pigment pooling at the dried edge
        blobPath(ctx, xx, yy, R, seed * 7, 0.42, 72);
        ctx.strokeStyle = rgba(c, 0.35);
        ctx.lineWidth = 1.4 * k;
        ctx.stroke();
      });
    }
  }
  // small drops and splatters
  for (let j = 0; j < 26; j++) {
    const x = r() * S;
    const y = r() * S;
    const R = (3 + r() * 9) * k;
    const c = cols[Math.floor(r() * cols.length)];
    const seed = 400 + j;
    wrap(S, x, y, R * 1.5, (xx, yy) => {
      blobPath(ctx, xx, yy, R, seed, 0.3, 24);
      ctx.fillStyle = rgba(c, 0.35);
      ctx.fill();
    });
  }
  ctx.globalCompositeOperation = 'source-over';
  // water blooms (back-runs)
  for (let j = 0; j < 8; j++) wash(ctx, S, r() * S, r() * S, (14 + r() * 20) * k, WHITE, 0.4);
  grain(ctx, S, 33, 0.1);
}

function drawMarble(ctx: Ctx2D, S: number): void {
  const vein = hex('#3f4350');
  const gold = hex('#c99b45');
  pixels(ctx, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    const n = fbm(11, u * 2, v * 2, 2, 2, 6);
    const n2 = fbm(23, u * 3, v * 3, 3, 3, 6);
    const cloud = fbm(5, u * 2, v * 2, 2, 2, 4);
    const a = Math.abs(Math.sin(TAU * (u + v) + 6 * n));
    const b = Math.abs(Math.sin(TAU * (2 * u - v) + 7 * n2));
    const g = Math.abs(Math.sin(TAU * (u - v) + 6 * n2 + 2));
    const main = Math.pow(1 - a, 26) * 0.6 + Math.pow(1 - a, 8) * 0.16 + Math.pow(1 - a, 3) * 0.07;
    const fine = Math.pow(1 - b, 70) * 0.45 + Math.pow(1 - b, 10) * 0.07;
    const gl = Math.pow(1 - g, 140);
    const base = 238 + (cloud - 0.5) * 22;
    const d = Math.min(1, main + fine);
    o[0] = lerp(base + 4, vein.r, d);
    o[1] = lerp(base + 1, vein.g, d);
    o[2] = lerp(base - 2, vein.b, d);
    o[0] = lerp(o[0], gold.r, gl * 0.85);
    o[1] = lerp(o[1], gold.g, gl * 0.85);
    o[2] = lerp(o[2], gold.b, gl * 0.85);
  });
}

function drawGalaxy(ctx: Ctx2D, S: number): void {
  const k = S / 512;
  const deep = hex('#1c1247');
  const mag = hex('#e0509f');
  const vio = hex('#7a52e6');
  const cya = hex('#3cc3ec');
  pixels(ctx, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    const w = fbm(4, u * 2, v * 2, 2, 2, 3);
    const n1 = fbm(41, u * 3 + w, v * 3 - w, 3, 3, 6);
    const n2 = fbm(57, u * 2, v * 2, 2, 2, 4);
    const lane = fbm(63, u * 4, v * 4, 4, 4, 5);
    const dens = smooth(0.38, 0.78, n1) * (1 - 0.65 * smooth(0.52, 0.72, lane));
    const c = n2 < 0.5 ? mix(mag, vio, n2 * 2) : mix(vio, cya, (n2 - 0.5) * 2);
    const glow = dens * dens;
    o[0] = deep.r + c.r * dens * 0.95 + 200 * glow * 0.35;
    o[1] = deep.g + c.g * dens * 0.95 + 200 * glow * 0.3;
    o[2] = deep.b + c.b * dens * 0.9 + 220 * glow * 0.35;
  });
  const r = rng(4409);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 900; i++) {
    const x = r() * S;
    const y = r() * S;
    const s = Math.pow(r(), 3) * 1.3 * k + 0.35 * k;
    ctx.fillStyle = `rgba(255,${235 + Math.floor(r() * 20)},${220 + Math.floor(r() * 35)},${0.35 + r() * 0.6})`;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < 34; i++) {
    const x = r() * S;
    const y = r() * S;
    const R = (4 + r() * 8) * k;
    const tint = r() < 0.5 ? hex('#bfe4ff') : hex('#ffd9f0');
    wrap(S, x, y, R * 3, (xx, yy) => {
      const g = ctx.createRadialGradient(xx, yy, 0, xx, yy, R);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.2, rgba(tint, 0.6));
      g.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = g;
      ctx.fillRect(xx - R, yy - R, R * 2, R * 2);
      if (R > 8 * k) {
        // four-point diffraction spikes
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 0.8 * k;
        ctx.beginPath();
        ctx.moveTo(xx - R * 3, yy);
        ctx.lineTo(xx + R * 3, yy);
        ctx.moveTo(xx, yy - R * 3);
        ctx.lineTo(xx, yy + R * 3);
        ctx.stroke();
      }
    });
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawAurora(ctx: Ctx2D, S: number): void {
  const bands = [
    { y0: 0.34, amp: 0.1, k: 1, ph: 0.4, h: 0.36, s: 1.0 },
    { y0: 0.8, amp: 0.07, k: 2, ph: 2.1, h: 0.3, s: 0.8 },
  ];
  const green = hex('#5ff5a6');
  const teal = hex('#36d0d8');
  const violet = hex('#a36bff');
  const sky0 = hex('#173a52');
  const sky1 = hex('#29275e');
  pixels(ctx, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    const sky = fbm(8, u * 2, v * 2, 2, 2, 3);
    let R = lerp(sky0.r, sky1.r, sky);
    let G = lerp(sky0.g, sky1.g, sky);
    let B = lerp(sky0.b, sky1.b, sky);
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const wob = (fbm(70 + i, u * 4, 0.5, 4, 1, 3) - 0.5) * 0.1;
      const yc = b.y0 + b.amp * Math.sin(TAU * u * b.k + b.ph) + 0.03 * Math.sin(TAU * u * 3 * b.k + b.ph * 2) + wob;
      // curtains brighten and fade along their length
      const fold = 0.35 + 0.65 * smooth(0.3, 0.7, fbm(80 + i, u * 3, 0.5, 3, 1, 3));
      let dy = v - yc;
      dy -= Math.round(dy); // toroidal wrap in y
      // rays rise above the curtain's bright lower hem and fade upwards
      const up = dy < 0 ? Math.exp(dy / b.h) * smooth(-b.h * 1.6, -b.h * 0.2, dy) : Math.exp(-(dy * dy) / 0.0006);
      const hem = Math.exp(-(dy * dy) / 0.0016);
      const rays = 0.35 + 0.65 * noise(90 + i, u * 128, 0.5, 128, 1) * (0.5 + 0.5 * noise(95 + i, u * 32, 0.5, 32, 1));
      const it = (up * rays * 0.85 + hem * 0.45) * b.s * fold;
      const t = clamp01(-dy / b.h);
      const c = t < 0.4 ? mix(green, teal, t / 0.4) : mix(teal, violet, (t - 0.4) / 0.6);
      R += c.r * it;
      G += c.g * it;
      B += c.b * it;
    }
    o[0] = R;
    o[1] = G;
    o[2] = B;
  });
  const r = rng(5501);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.5})`;
    ctx.beginPath();
    ctx.arc(r() * S, r() * S, (0.4 + Math.pow(r(), 4) * 1.2) * (S / 512), 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawHolographic(ctx: Ctx2D, S: number): void {
  pixels(ctx, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    const crinkle = fbm(17, u * 6, v * 6, 6, 6, 4);
    const warp = fbm(29, u * 2, v * 2, 2, 2, 3);
    const t = (u + v) * 2 + warp * 1.2 + crinkle * 0.55;
    // thin-film style cosine palette, pastelised
    const cr = 0.5 + 0.5 * Math.cos(TAU * (t + 0.0));
    const cg = 0.5 + 0.5 * Math.cos(TAU * (t + 0.33));
    const cb = 0.5 + 0.5 * Math.cos(TAU * (t + 0.67));
    const sheen = Math.pow(0.5 + 0.5 * Math.sin(TAU * (u - v) * 2 + crinkle * 4 + warp * 3), 3) * 0.12;
    const facet = (crinkle - 0.5) * 0.18;
    o[0] = 255 * clamp01(0.68 + 0.3 * cr + sheen + facet);
    o[1] = 255 * clamp01(0.66 + 0.3 * cg + sheen + facet);
    o[2] = 255 * clamp01(0.74 + 0.26 * cb + sheen + facet);
  });
  const r = rng(6607);
  const k = S / 512;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 40; i++) {
    const x = r() * S;
    const y = r() * S;
    const R = (3 + r() * 7) * k;
    wrap(S, x, y, R * 2.5, (xx, yy) => star4(ctx, xx, yy, R, 0.85));
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** A soft four-pointed glint. */
function star4(ctx: Ctx2D, x: number, y: number, R: number, a: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.beginPath();
  const L = R * 2.5;
  const w = R * 0.14;
  ctx.moveTo(x, y - L);
  ctx.quadraticCurveTo(x + w, y - w, x + L, y);
  ctx.quadraticCurveTo(x + w, y + w, x, y + L);
  ctx.quadraticCurveTo(x - w, y + w, x - L, y);
  ctx.quadraticCurveTo(x - w, y - w, x, y - L);
  ctx.fill();
}

function drawWood(ctx: Ctx2D, S: number): void {
  const light = hex('#e6b983');
  const mid = hex('#c88b52');
  const dark = hex('#7f4a26');
  const knots = [
    { x: 0.32, y: 0.62, r: 0.05 },
    { x: 0.81, y: 0.18, r: 0.035 },
  ];
  pixels(ctx, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    let t = u * 14 + 1.6 * fbm(3, u * 4, v * 1, 4, 1, 4) + 0.35 * Math.sin(TAU * v * 2 + u * TAU);
    for (const kn of knots) {
      let dx = u - kn.x;
      let dy = v - kn.y;
      dx -= Math.round(dx);
      dy -= Math.round(dy);
      const d2 = (dx * dx) / (kn.r * kn.r) + (dy * dy) / (kn.r * kn.r * 6);
      t += 2.4 * Math.exp(-d2) * Math.sign(dx || 1);
    }
    const ring = t - Math.floor(t);
    const late = smooth(0.62, 0.92, ring) * (1 - smooth(0.94, 1, ring));
    const pores = Math.pow(noise(7, u * 192, v * 6, 192, 6), 3);
    const tone = fbm(13, u * 3, v * 3, 3, 3, 3);
    const base = mix(light, mid, tone * 0.8);
    let c = mix(base, dark, late * 0.75);
    c = mix(c, dark, pores * 0.35);
    const sheen = 1 + 0.06 * Math.sin(TAU * (u * 3 + v));
    o[0] = c.r * sheen;
    o[1] = c.g * sheen;
    o[2] = c.b * sheen;
  });
}

function drawConfetti(ctx: Ctx2D, S: number): void {
  const k = S / 512;
  const r = rng(7703);
  ctx.fillStyle = '#fff8ef';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 8; i++) wash(ctx, S, r() * S, r() * S, (90 + r() * 80) * k, hex(['#ffe3ec', '#e5f3ff', '#fff2d6'][i % 3]), 0.7);
  const cols = ['#ff6f91', '#ffc75f', '#4ecdc4', '#845ec2', '#5fa8ff', '#ff9671', '#7ad48a', '#f9f871'];
  for (let i = 0; i < 150; i++) {
    const x = r() * S;
    const y = r() * S;
    const c = cols[Math.floor(r() * cols.length)];
    const kind = r();
    const s = (9 + r() * 11) * k;
    const rot = r() * TAU;
    wrap(S, x, y, s * 3, (xx, yy) => {
      ctx.save();
      ctx.translate(xx, yy);
      ctx.rotate(rot);
      ctx.fillStyle = c;
      ctx.strokeStyle = c;
      ctx.shadowColor = 'rgba(80,40,60,0.18)';
      ctx.shadowBlur = 2 * k;
      ctx.shadowOffsetY = 1 * k;
      if (kind < 0.3) {
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.55, 0, TAU);
        ctx.fill();
      } else if (kind < 0.58) {
        roundRect(ctx, -s * 0.9, -s * 0.35, s * 1.8, s * 0.7, s * 0.15);
        ctx.fill();
      } else if (kind < 0.72) {
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.7);
        ctx.lineTo(s * 0.65, s * 0.5);
        ctx.lineTo(-s * 0.65, s * 0.5);
        ctx.closePath();
        ctx.fill();
      } else if (kind < 0.9) {
        // curly streamer
        ctx.lineWidth = s * 0.28;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let j = 0; j <= 16; j++) {
          const px = (j / 16 - 0.5) * s * 4;
          const py = Math.sin((j / 16) * TAU * 1.5) * s * 0.5;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      } else {
        ctx.beginPath();
        for (let j = 0; j < 10; j++) {
          const a = (j / 10) * TAU - Math.PI / 2;
          const rr = j % 2 ? s * 0.32 : s * 0.75;
          if (j === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });
  }
}

function drawGlitter(ctx: Ctx2D, S: number): void {
  const champagne = hex('#ecd6a6');
  const gold = hex('#c99a52');
  const rose = hex('#e8b0a4');
  const cellPx = Math.max(2, Math.round(S / 192));
  const cells = Math.floor(S / cellPx);
  pixels(ctx, S, (x, y, o) => {
    const u = x / S;
    const v = y / S;
    const tone = fbm(19, u * 3, v * 3, 3, 3, 4);
    const roseAmt = smooth(0.45, 0.75, fbm(27, u * 2, v * 2, 2, 2, 3));
    const base = mix(mix(gold, champagne, tone), rose, roseAmt * 0.6);
    const cx = Math.floor(x / cellPx) % cells;
    const cy = Math.floor(y / cellPx) % cells;
    const f = hash(cx + 31, cy * 977 + 5);
    const flake = Math.pow(f, 5) * 1.6 + (f - 0.5) * 0.35;
    const k2 = 0.82 + flake;
    o[0] = base.r * k2 + 40 * Math.pow(f, 12);
    o[1] = base.g * k2 + 40 * Math.pow(f, 12);
    o[2] = base.b * k2 + 40 * Math.pow(f, 12);
  });
  const r = rng(8807);
  const k = S / 512;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 55; i++) {
    const x = r() * S;
    const y = r() * S;
    const R = (2 + Math.pow(r(), 2) * 7) * k;
    wrap(S, x, y, R * 2.5, (xx, yy) => star4(ctx, xx, yy, R, 0.75));
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawStainedGlass(ctx: Ctx2D, S: number): void {
  const r = rng(9901);
  const G = 6;
  const seeds: { x: number; y: number; c: RGB }[] = [];
  const jewels = ['#e2566f', '#4f7fe0', '#36b487', '#f2b544', '#a467dc', '#3fc4cf', '#f193b8', '#f5e3b5', '#7cc0f0', '#e88a4a'].map(hex);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      seeds.push({ x: ((gx + 0.15 + r() * 0.7) / G) * S, y: ((gy + 0.15 + r() * 0.7) / G) * S, c: jewels[Math.floor(r() * jewels.length)] });
    }
  }
  const lead = hex('#231f2b');
  const half = S / 2;
  const leadW = S / 160;
  const cellR = S / G;
  pixels(ctx, S, (x, y, o) => {
    let d1 = Infinity;
    let d2 = Infinity;
    let i1 = 0;
    let i2 = 0;
    for (let i = 0; i < seeds.length; i++) {
      let dx = x - seeds[i].x;
      let dy = y - seeds[i].y;
      if (dx > half) dx -= S;
      else if (dx < -half) dx += S;
      if (dy > half) dy -= S;
      else if (dy < -half) dy += S;
      const d = dx * dx + dy * dy;
      if (d < d1) {
        d2 = d1;
        i2 = i1;
        d1 = d;
        i1 = i;
      } else if (d < d2) {
        d2 = d;
        i2 = i;
      }
    }
    let sx = seeds[i2].x - seeds[i1].x;
    let sy = seeds[i2].y - seeds[i1].y;
    if (sx > half) sx -= S;
    else if (sx < -half) sx += S;
    if (sy > half) sy -= S;
    else if (sy < -half) sy += S;
    const edge = (d2 - d1) / (2 * Math.sqrt(sx * sx + sy * sy) + 1e-6);
    const u = x / S;
    const v = y / S;
    const mott = fbm(37, u * 10, v * 10, 10, 10, 3);
    const glow = 1 - Math.min(1, Math.sqrt(d1) / cellR);
    const c = seeds[i1].c;
    const shade = 0.72 + 0.38 * glow + (mott - 0.5) * 0.35;
    const sheen = Math.pow(0.5 + 0.5 * Math.sin(TAU * (u + v) * 1 + 1), 8) * 60;
    let R = c.r * shade + sheen;
    let Gc = c.g * shade + sheen;
    let B = c.b * shade + sheen;
    // lead came with a little bevel highlight
    const lw = smooth(leadW * 1.05, leadW * 0.7, edge);
    const bev = Math.exp(-Math.pow((edge - leadW * 0.35) / (leadW * 0.25), 2)) * 0.5;
    R = lerp(R, lead.r + 90 * bev, lw);
    Gc = lerp(Gc, lead.g + 90 * bev, lw);
    B = lerp(B, lead.b + 100 * bev, lw);
    o[0] = R;
    o[1] = Gc;
    o[2] = B;
  });
}

function drawGeometric(ctx: Ctx2D, S: number): void {
  // art-deco fan scales: rows of overlapping concentric fans
  const cols = 6;
  const w = S / cols;
  const rows = 12;
  const h = S / rows;
  const fills = ['#1f4e5a', '#2f7a7c', '#7fc1b0', '#e9e0c9', '#f3ead6'];
  ctx.fillStyle = '#163a44';
  ctx.fillRect(0, 0, S, S);
  for (let row = -1; row <= rows + 1; row++) {
    const off = (row & 1) * w * 0.5;
    for (let c = -1; c <= cols; c++) {
      const cx = c * w + off + w / 2;
      const cy = row * h + h;
      const R = w * 0.62;
      for (let ring = 0; ring < 5; ring++) {
        const rr = R * (1 - ring * 0.19);
        ctx.beginPath();
        ctx.arc(cx, cy, rr, Math.PI, TAU);
        ctx.closePath();
        ctx.fillStyle = fills[ring];
        ctx.fill();
        ctx.strokeStyle = '#d6b264';
        ctx.lineWidth = Math.max(1, S / 340);
        ctx.stroke();
      }
      // radiating gold ribs
      ctx.strokeStyle = 'rgba(214,178,100,0.85)';
      ctx.lineWidth = Math.max(0.7, S / 600);
      for (let j = 1; j < 8; j++) {
        const a = Math.PI + (j / 8) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * R * 0.25, cy + Math.sin(a) * R * 0.25);
        ctx.lineTo(cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62);
        ctx.stroke();
      }
      ctx.fillStyle = '#e8c878';
      ctx.beginPath();
      ctx.arc(cx, cy - R * 0.1, Math.max(1.2, S / 260), 0, TAU);
      ctx.fill();
    }
  }
}

function drawLavender(ctx: Ctx2D, S: number): void {
  // pressed-botanical sprigs of lavender and eucalyptus on soft linen
  const k = S / 512;
  const r = rng(10_501);
  ctx.fillStyle = '#f5f1ea';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 10; i++) wash(ctx, S, r() * S, r() * S, (80 + r() * 100) * k, hex(['#ece4f6', '#e7efe6', '#f7ece4'][i % 3]), 0.7);
  for (let i = 0; i < 40; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = (110 + r() * 90) * k;
    const a = -Math.PI / 2 + (r() - 0.5) * 1.6;
    const bend = (r() - 0.5) * 0.5;
    const isEuc = r() < 0.4;
    const seed = 600 + i;
    wrap(S, x, y, len, (xx, yy) => {
      const rr = rng(seed);
      ctx.save();
      ctx.translate(xx, yy);
      ctx.rotate(a + Math.PI / 2);
      ctx.strokeStyle = isEuc ? '#6f8f86' : '#7c8f6a';
      ctx.lineWidth = 1.4 * k;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * bend, -len * 0.5, 0, -len);
      ctx.stroke();
      if (isEuc) {
        for (let j = 1; j < 7; j++) {
          const t = j / 7;
          const px = 2 * (1 - t) * t * len * bend;
          const py = -len * t;
          const R = (13 - j * 0.9) * k;
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = j % 2 ? '#8fb0a6' : '#a8c4ba';
          ctx.beginPath();
          ctx.ellipse(px + (j % 2 ? R : -R) * 0.8, py, R, R * 0.8, 0, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = '#4f6e65';
          ctx.lineWidth = 0.8 * k;
          ctx.stroke();
        }
      } else {
        // florets clustered on the upper third
        for (let j = 0; j < 40; j++) {
          const t = 0.5 + (j / 40) * 0.5;
          const px = 2 * (1 - t) * t * len * bend + (rr() - 0.5) * 10 * k * (1.2 - t * 0.5);
          const py = -len * t;
          const R = (3.6 + rr() * 2.4) * k * (1.25 - t * 0.45);
          const c = mix(hex('#6a4fb3'), hex('#b9a3ec'), rr());
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = rgba(c, 1);
          ctx.beginPath();
          ctx.ellipse(px, py, R, R * 1.3, (rr() - 0.5) * 0.8, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }
  grain(ctx, S, 55, 0.07);
}

export const DECAL_PATTERNS: DecalPattern[] = [
  { id: 'meadow', name: 'Meadow', draw: drawMeadow },
  { id: 'sakura', name: 'Sakura', draw: drawSakura },
  { id: 'lavender', name: 'Lavender sprigs', draw: drawLavender },
  { id: 'watercolor', name: 'Watercolor', draw: drawWatercolor },
  { id: 'marble', name: 'Marble', draw: drawMarble },
  { id: 'galaxy', name: 'Galaxy', draw: drawGalaxy },
  { id: 'aurora', name: 'Aurora', draw: drawAurora },
  { id: 'holographic', name: 'Holographic', draw: drawHolographic },
  { id: 'glitter', name: 'Glitter', draw: drawGlitter },
  { id: 'stained-glass', name: 'Stained glass', draw: drawStainedGlass },
  { id: 'geometric', name: 'Art deco', draw: drawGeometric },
  { id: 'wood', name: 'Wood grain', draw: drawWood },
  { id: 'confetti', name: 'Confetti', draw: drawConfetti },
];

const tileCache = new Map<string, AnyCanvas>();
/** Tiles we generated (seamless) — user images are not in here. */
const generatedTiles = new WeakSet<object>();

export function getPatternTile(id: string, size = 512): AnyCanvas | null {
  const key = `${id}@${size}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const pat = DECAL_PATTERNS.find((p) => p.id === id);
  if (!pat) return null;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d') as Ctx2D | null;
  if (!ctx) return null;
  ctx.save();
  pat.draw(ctx, size);
  ctx.restore();
  tileCache.set(key, c);
  generatedTiles.add(c);
  return c;
}

// ---------------------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------------------

export interface NoteDecalParams {
  /** decal source image (pattern tile or user image) */
  image: CanvasImageSource;
  imageWidth: number;
  imageHeight: number;
  settings: DecalSettings;
  /** the note's display colour (hand / pitch / single colour, already highlight-adjusted) */
  color: RGB;
  noteId: number;
  /** y of the note's bottom edge for 'note' anchoring (so the decal moves with the note) */
  anchorY: number;
  /** renderer scale (canvas height / 1080) */
  scale: number;
  /** true when the note is currently sounding */
  active: boolean;
}

/** On-screen width of one pattern tile at 1080p and decal scale 1. */
const TILE_DISPLAY_PX = 300;
/** For user photos: on-screen width ≈ this many note widths. */
const IMAGE_NOTE_SPAN = 3.5;
/** Nominal note width at 1080p used to size user photos when the decal is screen-anchored. */
const NOMINAL_NOTE_W = 34;

/** The decal at its exact on-screen size with tint & opacity baked in, tiled 2×2. */
interface Baked {
  /** 2w × 2h: any w × h crop of the (wrapping) decal is one contiguous region of this */
  canvas: AnyCanvas;
}
interface Resampled {
  w: number;
  h: number;
  /** w × h, resampled once from the source (opaque) */
  canvas: AnyCanvas;
  /** tint / alpha key → baked copy (most recently used last) */
  variants: Map<string, Baked>;
}
/** image → a few pre-resampled copies at the exact on-screen size (most recent first). */
const resampleCache = new WeakMap<object, Resampled[]>();
/** Baked variants kept per resampled size. Keys depend only on the tint setting and the
 *  caller's alpha (normal / muted hand), never on note colours, so a handful is plenty. */
const MAX_VARIANTS = 6;

/**
 * Pre-resample the source to the on-screen size once, so per-note painting is a pure 1:1
 * copy (crisp, alias-free and fast). Seamless tiles are resampled with their wrapped
 * neighbours so the filtered edges still join without a seam.
 */
function resampled(img: CanvasImageSource, iw: number, ih: number, w: number, h: number, seamless: boolean): Resampled | null {
  let list = resampleCache.get(img as object);
  if (!list) {
    list = [];
    resampleCache.set(img as object, list);
  }
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.w === w && e.h === h) {
      if (i > 0) {
        list.splice(i, 1);
        list.unshift(e);
      }
      return e;
    }
  }
  const canvas = makeCanvas(w, h);
  const c = canvas.getContext('2d') as Ctx2D | null;
  if (!c) return null;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  try {
    if (seamless) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) c.drawImage(img, 0, 0, iw, ih, dx * w, dy * h, w, h);
    } else {
      c.drawImage(img, 0, 0, iw, ih, 0, 0, w, h);
    }
  } catch {
    return null; // e.g. an image that is not decoded yet
  }
  const e: Resampled = { w, h, canvas, variants: new Map() };
  list.unshift(e);
  if (list.length > 3) list.length = 3;
  return e;
}

/**
 * Bake tint and opacity into a 2×2-tiled copy.
 *
 * Tint: the decal's pale ground turns partly transparent (in proportion to its lightness
 * and the tint amount), so the note's own hand / pitch colour, already painted underneath,
 * glows through while darker motifs stay solid and readable. Unlike a 'color' blend this
 * keeps every flower's hue, and because it does not depend on the note colour one copy
 * serves every note — no per-note blend pass (which in software raster cost more than the
 * decal itself). Opacity × the caller's globalAlpha is baked in too: an image drawn with
 * globalAlpha < 1 is ~2× slower than one whose pixels already carry the alpha.
 */
function baked(rs: Resampled, tint: number, alpha: number): Baked | null {
  const qt = Math.round(tint * 50) / 50;
  const qa = Math.round(alpha * 64) / 64;
  const key = `t${qt}a${qa}`;
  const hit = rs.variants.get(key);
  if (hit) {
    if (rs.variants.size > 1) {
      rs.variants.delete(key);
      rs.variants.set(key, hit);
    }
    return hit;
  }
  const W = rs.w * 2;
  const H = rs.h * 2;
  const canvas = makeCanvas(W, H);
  const c = canvas.getContext('2d', { willReadFrequently: true }) as Ctx2D | null;
  if (!c) return null;
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) c.drawImage(rs.canvas, dx * rs.w, dy * rs.h);
  if (qt > 0 || qa < 1) {
    const img = c.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      const t = clamp01((l - 0.3) / 0.65);
      const keep = 1 - qt * t * Math.sqrt(t);
      d[i + 3] = Math.round(d[i + 3] * keep * qa);
    }
    c.putImageData(img, 0, 0);
  }
  const b: Baked = { canvas };
  rs.variants.set(key, b);
  if (rs.variants.size > MAX_VARIANTS) rs.variants.delete(rs.variants.keys().next().value as string);
  return b;
}

const posMod = (v: number, m: number) => v - m * Math.floor(v / m);

/**
 * Copy the decal into the box [x0,x1]×[y0,y1] with plain drawImage calls (usually one).
 * (ox, oy) is the integer screen position of the decal's origin, so source and
 * destination differ by a whole-pixel translation — no resampling, the fastest path.
 */
function blit(ctx: Ctx2D, bk: Baked, w: number, h: number, ox: number, oy: number, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y < y1 - 0.01; ) {
    const sy = posMod(y - oy, h);
    const hh = Math.min(y1 - y, 2 * h - sy);
    for (let x = x0; x < x1 - 0.01; ) {
      const sx = posMod(x - ox, w);
      const ww = Math.min(x1 - x, 2 * w - sx);
      ctx.drawImage(bk.canvas, sx, sy, ww, hh, x, y, ww, hh);
      x += ww;
    }
    y += hh;
  }
}

/**
 * Paint the decal inside the rounded rect. Must leave ctx state as it found it.
 *
 * Implementation note: rather than a CanvasPattern fill, the note is clipped and the decal
 * copied with drawImage from a pre-baked 2×2 tile (so every crop is contiguous). Measured
 * in headless Chromium (software raster) with the renderer's gradient fill + glow stroke
 * interleaved, pattern fills of each note cost ~2× more, and per-note blend passes for
 * tint/alpha more again; see tests/e2e/fx-decals.ts (?mode=perf).
 */
export function paintNoteDecal(ctx: Ctx2D, rect: { x: number; y: number; w: number; h: number }, radius: number, p: NoteDecalParams): void {
  const s = p.settings;
  const opacity = clamp01(s.opacity);
  if (opacity <= 0 || !(rect.w >= 1) || !(rect.h >= 1) || p.imageWidth < 1 || p.imageHeight < 1) return;
  const seamless = generatedTiles.has(p.image as object);
  const userScale = Math.max(0.1, s.scale || 1);

  // on-screen size of one repeat of the decal
  let dw: number;
  if (seamless) dw = TILE_DISPLAY_PX * p.scale * userScale;
  else {
    // photos: one image spans ~3–4 note widths
    const noteW = s.anchor === 'note' ? Math.max(rect.w, 12 * p.scale) : NOMINAL_NOTE_W * p.scale;
    dw = noteW * IMAGE_NOTE_SPAN * userScale;
  }
  dw = Math.max(16, Math.min(2048, Math.round(dw)));
  const dh = Math.max(16, Math.min(2048, Math.round((dw * p.imageHeight) / p.imageWidth)));
  const rs = resampled(p.image, p.imageWidth, p.imageHeight, dw, dh, seamless);
  if (!rs) return;
  const baseAlpha = ctx.globalAlpha;
  const bk = baked(rs, clamp01(s.tint), baseAlpha * opacity);
  if (!bk) return;

  // Integer origin of the decal on screen. Whole pixels keep every copy a 1:1 blit
  // (sub-pixel offsets force bilinear filtering, ~3× slower in software raster), and a
  // ≤ 0.5 px shift of the decal inside a moving note is invisible.
  let ox = 0;
  let oy = 0;
  if (s.anchor === 'note') {
    // each note shows its own crop, and the crop travels with the note
    ox = Math.round(rect.x) - Math.floor(hash(p.noteId, 101) * dw);
    oy = Math.round(p.anchorY) - Math.floor(hash(p.noteId, 202) * dh);
  }

  const { x, y, w, h } = rect;
  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1; // opacity × caller alpha are baked into the copy
  ctx.imageSmoothingEnabled = false;
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  blit(ctx, bk, dw, dh, ox, oy, Math.floor(x), Math.ceil(x + w), Math.floor(y), Math.ceil(y + h));
  // sounding notes light up with a soft wash of their own colour
  if (p.active) {
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = baseAlpha * 0.22;
    ctx.fillStyle = rgba(mix(p.color, WHITE, 0.7), 1);
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}
