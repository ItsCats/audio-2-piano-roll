/**
 * Hit & ambience effects drawn by the renderer.
 *
 * CONTRACT (used by renderer.ts — keep these signatures). Every effect is a PURE FUNCTION OF
 * TIME: given the same notes and `now`, it draws the same pixels (no Math.random, no state
 * carried between frames) so seeking works and exported video frames are deterministic.
 * Use `hash()` from ./color for pseudo-randomness seeded by note id / particle index.
 *
 * Performance: every soft shape (halo, core, rays, streaks, glitter, key spill) is a sprite
 * pre-rendered once into an offscreen canvas and then blitted with drawImage. Sprites are keyed
 * by a QUANTISED colour and always built from that quantised colour, so a sprite's pixels never
 * depend on which note happened to create it first (the cache is invisible to the output).
 * Per-note lookups go through small numeric-keyed caches (packed RGB + size) so the hot loops
 * allocate no strings or colour objects.
 */
import type { EffectSettings } from './settings';
import { hash, makeCanvas, mix, rgba, WHITE, type AnyCanvas, type Ctx2D, type RGB } from './color';

/** A note relevant to effects: currently sounding, or ended within DUST_LOOKBACK seconds. */
export interface FxNote {
  id: number;
  midi: number;
  /** key centre x and key width in px */
  x: number;
  w: number;
  black: boolean;
  color: RGB;
  start: number;
  end: number;
  vel: number;
}

export interface FxGeometry {
  width: number;
  height: number;
  /** y of the hit line (top of the keyboard) */
  hitY: number;
  /** keyboard height in px (0 if hidden) */
  kbH: number;
  /** canvas height / 1080 */
  scale: number;
}

/** How long (s) after a note ends its effects (dust) may still be visible. */
export const DUST_LOOKBACK = 3;

/**
 * How long (s) bursts and key light take to fade out after note-off. The renderer must pass
 * notes that ended up to this long ago (lookback >= FX_RELEASE) for the release to show.
 */
export const FX_RELEASE = 0.12;

// ---------------------------------------------------------------------------------------------
// sprite cache
// ---------------------------------------------------------------------------------------------

type Sprite = AnyCanvas | ImageBitmap;

const sprites = new Map<string, Sprite>();
const MAX_SPRITE_PX = 10_000_000; // ~40 MB of sprite pixels before the cache is reset
let spritePx = 0;

/**
 * Reset the caches once they exceed the budget. Called ONLY at the start of an exported draw
 * function, so no sprite obtained earlier in the same call can be dropped. Bitmaps are never
 * close()d: a dropped one may still be referenced (e.g. by an in-flight frame), so it is left
 * to the garbage collector. Rebuilt sprites are pixel-identical, so this never changes output.
 */
function checkBudget(): void {
  if (spritePx <= MAX_SPRITE_PX) return;
  sprites.clear();
  burstSets.clear();
  dustSets.clear();
  keySets.clear();
  coreStyleCache.clear();
  spritePx = 0;
}

function sprite(key: string, w: number, h: number, paint: (c: Ctx2D, w: number, h: number) => void): Sprite {
  const hit = sprites.get(key);
  if (hit) return hit;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const cv = makeCanvas(w, h);
  const c = cv.getContext('2d') as Ctx2D;
  paint(c, w, h);
  // An ImageBitmap is an immutable GPU/raster-ready image: drawing it is markedly cheaper than
  // drawing a canvas (which must be snapshotted on every use).
  const out: Sprite = 'transferToImageBitmap' in cv ? cv.transferToImageBitmap() : cv;
  sprites.set(key, out);
  spritePx += w * h;
  return out;
}

/** Quantise a channel to 5 bits (similar colours share sprites). */
const q5 = (v: number) => {
  const i = Math.round(v);
  return i <= 0 ? 4 : i >= 255 ? 252 : ((i >> 3) << 3) + 4;
};
/** Quantised colour packed into a 24-bit integer (no allocation). */
const qpack = (c: RGB) => (q5(c.r) << 16) | (q5(c.g) << 8) | q5(c.b);
const unpack = (p: number): RGB => ({ r: (p >> 16) & 255, g: (p >> 8) & 255, b: p & 255 });
const quant = (c: RGB) => unpack(qpack(c));
const ckey = (c: RGB) => `${c.r},${c.g},${c.b}`;

/** Radial glow: colour `c`, smooth (roughly gaussian) falloff, transparent at the edge. */
function glowSprite(c: RGB, hot = 0): Sprite {
  return sprite(`glow:${ckey(c)}:${hot}`, 128, 128, (g, w) => {
    const r = w / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    const core = mix(c, WHITE, hot);
    gr.addColorStop(0, rgba(core, 1));
    gr.addColorStop(0.12, rgba(mix(c, WHITE, hot * 0.6), 0.78));
    gr.addColorStop(0.3, rgba(c, 0.42));
    gr.addColorStop(0.55, rgba(c, 0.15));
    gr.addColorStop(0.8, rgba(c, 0.04));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
}

/** Hot white core: a broad bright centre with a soft shoulder. */
function coreSprite(): Sprite {
  return sprite('core', 128, 128, (g, w) => {
    const r = w / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.15, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.15)');
    gr.addColorStop(0.8, 'rgba(255,255,255,0.04)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
}

/** Steep point light (for thin lines such as the lens streak). */
function pointSprite(): Sprite {
  return sprite('point', 128, 128, (g, w) => {
    const r = w / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.08, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.2, 'rgba(255,255,255,0.45)');
    gr.addColorStop(0.42, 'rgba(255,255,255,0.12)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0.025)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
}

/** Thin starburst rays (white). A few deterministic variants with different ray layouts. */
function raySprite(variant: number): Sprite {
  return sprite(`rays:${variant}`, 256, 256, (g, w) => {
    const r = w / 2;
    g.globalCompositeOperation = 'lighter';
    const n = 10 + Math.floor(hash(variant, 1) * 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (hash(variant, i + 10) - 0.5) * 0.45;
      const major = i % 2 === 0;
      const len = r * (major ? 0.72 + 0.28 * hash(variant, i + 40) : 0.3 + 0.4 * hash(variant, i + 40));
      const half = (major ? 0.028 : 0.016) + hash(variant, i + 70) * 0.012;
      const alpha = major ? 1 : 0.6;
      // two passes: a soft wide wedge and a crisp thin one
      for (const [hw, al] of [[half * 2.6, alpha * 0.24], [half, alpha]] as const) {
        const gr = g.createRadialGradient(r, r, 0, r, r, len);
        gr.addColorStop(0, `rgba(255,255,255,${al})`);
        gr.addColorStop(0.25, `rgba(255,255,255,${al * 0.85})`);
        gr.addColorStop(0.6, `rgba(255,255,255,${al * 0.45})`);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(r + Math.cos(a - hw) * 2, r + Math.sin(a - hw) * 2);
        g.lineTo(r + Math.cos(a) * len, r + Math.sin(a) * len);
        g.lineTo(r + Math.cos(a + hw) * 2, r + Math.sin(a + hw) * 2);
        g.closePath();
        g.fill();
      }
    }
  });
}

/**
 * The coloured part of the sustained flare, pre-composited at its final pixel size: coloured
 * halo, a thin vertical spike, white starburst rays and a soft white glow. It never clips, so
 * scaling it by alpha dims it smoothly. The hit point is at (W/2, burstUp(R)).
 */
const burstUp = (R: number) => Math.ceil(3.2 * R); // sprite rows above the hit point
function burstSprite(c: RGB, variant: number, R: number): Sprite {
  const W = 2 * Math.ceil(2.2 * R);
  const H = burstUp(R) + Math.ceil(1.8 * R);
  return sprite(`burst:${ckey(c)}:${variant}:${R}`, W, H, (g) => {
    const m = W / 2;
    const cy = burstUp(R);
    g.globalCompositeOperation = 'lighter';
    const core = coreSprite();
    const put = (img: Sprite, a: number, cx: number, y: number, w: number, h: number) => {
      g.globalAlpha = a;
      g.drawImage(img as CanvasImageSource, cx - w / 2, y - h / 2, w, h);
    };
    put(glowSprite(c, 0.3), 0.66, m, cy - R * 0.45, 4.4 * R, 4.2 * R);
    put(core, 0.4, m, cy - R * 1.6, 0.4 * R, 3.2 * R); // thin tall spike
    put(raySprite(variant), 1, m, cy - R * 0.1, 4.4 * R, 4.4 * R);
    put(core, 0.35, m, cy - R * 0.6, 1.8 * R, 2.6 * R);
  });
}

/**
 * The white-hot heart of the flare (colour independent): a round bloom on the hit point and a
 * taller column of light rising through the bottom of the note. Its centre clips to pure white,
 * so it is scaled mostly by SIZE (not alpha) to avoid a flat grey plateau.
 * The hit point is at (W/2, hotUp(R)).
 */
const hotUp = (R: number) => Math.ceil(2.6 * R);
function hotSprite(R: number): Sprite {
  const W = 2 * Math.ceil(1.4 * R);
  const H = hotUp(R) + Math.ceil(1.1 * R);
  return sprite(`hot:${R}`, W, H, (g) => {
    const m = W / 2;
    const cy = hotUp(R);
    g.globalCompositeOperation = 'lighter';
    const core = coreSprite();
    const put = (a: number, y: number, w: number, h: number) => {
      g.globalAlpha = a;
      g.drawImage(core as CanvasImageSource, m - w / 2, y - h / 2, w, h);
    };
    put(0.85, cy - R * 0.3, 2.8 * R, 2.3 * R); // round bloom
    put(0.6, cy - R * 0.85, 1.5 * R, 3.1 * R); // rising column
  });
}

/** Horizontal anamorphic lens streak: coloured haze plus a thin white line. */
function streakSprite(c: RGB, R: number): Sprite {
  const W = 2 * Math.ceil(3.3 * R);
  const H = 2 * Math.ceil(0.3 * R) + 2;
  return sprite(`streak:${ckey(c)}:${R}`, W, H, (g) => {
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.6;
    g.drawImage(glowSprite(c, 0.25) as CanvasImageSource, 0, H / 2 - 0.27 * R, W, 0.54 * R);
    g.globalAlpha = 0.95;
    const lh = 0.14 * R + 1.5;
    g.drawImage(pointSprite() as CanvasImageSource, 0, H / 2 - lh / 2, W, lh);
  });
}

/** Glitter grain glow: hard bright centre and a small coloured glow. */
function grainSprite(c: RGB): Sprite {
  return sprite(`grain:${ckey(c)}`, 24, 24, (g, w) => {
    const r = w / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.14, rgba(mix(c, WHITE, 0.6), 0.95));
    gr.addColorStop(0.26, rgba(c, 0.45));
    gr.addColorStop(0.55, rgba(c, 0.1));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
}

/** fillStyle strings for a grain core at each brightness level (index 1..DUST_LEVELS). */
const coreStyleCache = new Map<number, string[]>();
function coreStyles(c: RGB): string[] {
  const k = (c.r << 16) | (c.g << 8) | c.b;
  let st = coreStyleCache.get(k);
  if (!st) {
    const hot = mix(c, WHITE, 0.55);
    st = [];
    for (let i = 0; i <= DUST_LEVELS; i++) st.push(rgba(hot, +(i / DUST_LEVELS).toFixed(3)));
    coreStyleCache.set(k, st);
  }
  return st;
}

/** Small soft smoke puff (sized close to how it is drawn, so no costly heavy downscaling). */
function wispSprite(c: RGB): Sprite {
  return sprite(`wisp:${ckey(c)}`, 40, 40, (g, w) => {
    const r = w / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, rgba(mix(c, WHITE, 0.2), 0.9));
    gr.addColorStop(0.35, rgba(c, 0.45));
    gr.addColorStop(0.7, rgba(c, 0.1));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
}

/** Four-point glint for the brightest twinkles. */
function glintSprite(c: RGB): Sprite {
  return sprite(`glint:${ckey(c)}`, 64, 64, (g, w) => {
    const r = w / 2;
    g.globalCompositeOperation = 'lighter';
    const cc = mix(c, WHITE, 0.5);
    for (const vertical of [false, true]) {
      const gr = vertical ? g.createLinearGradient(r, 0, r, w) : g.createLinearGradient(0, r, w, r);
      gr.addColorStop(0, rgba(cc, 0));
      gr.addColorStop(0.5, rgba(WHITE, 0.95));
      gr.addColorStop(1, rgba(cc, 0));
      g.fillStyle = gr;
      if (vertical) g.fillRect(r - 0.9, 0, 1.8, w);
      else g.fillRect(0, r - 0.9, w, 1.8);
    }
    const gr = g.createRadialGradient(r, r, 0, r, r, r * 0.35);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, rgba(cc, 0.5));
    gr.addColorStop(1, rgba(cc, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
}

/**
 * Light falling onto the keys: alpha mask that is widest/brightest at the top, gaussian
 * across, fading downward. `mode` 0 = tint (for multiply), 1 = glow (for screen).
 */
function spillSprite(c: RGB, mode: 0 | 1, W: number, H: number): Sprite {
  return sprite(`spill:${ckey(c)}:${mode}:${W}x${H}`, W, H, (g, w, h) => {
    const img = g.createImageData(w, h);
    const d = img.data;
    const col = mode === 0 ? mix(c, WHITE, 0.05) : c;
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1);
      const fall = mode === 0 ? Math.pow(1 - v * 0.85, 1.1) : Math.pow(1 - v, 1.2) * (0.5 + 0.5 * Math.exp(-v * 4));
      // the beam widens slightly as it falls, like a cone of light
      const sig = mode === 0 ? 0.17 + 0.08 * v : 0.2 + 0.1 * v;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w - 0.5;
        const across = Math.exp(-(u * u) / (2 * sig * sig));
        const a = Math.max(0, Math.min(1, fall * across));
        const i = (y * w + x) * 4;
        d[i] = col.r;
        d[i + 1] = col.g;
        d[i + 2] = col.b;
        d[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/**
 * Additive part of the key light at its final pixel size: the light cone on the keys plus a
 * bloom where the light enters the keyboard. The keyboard top is at y = 0.
 */
function keyGlowSprite(c: RGB, W: number, kb: number): Sprite {
  const H = Math.round(kb * 0.8);
  return sprite(`keyglow:${ckey(c)}:${W}x${kb}`, W, H, (g) => {
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.3;
    g.drawImage(spillSprite(c, 1, W, kb) as CanvasImageSource, 0, 0);
    g.globalAlpha = 0.18;
    g.drawImage(glowSprite(c, 0) as CanvasImageSource, W * 0.2, kb * 0.15 - kb * 0.22, W * 0.6, kb * 0.44);
  });
}

/** Bloom where the light enters the keyboard (a flat glow along the keyboard's top edge). */
function keyBloomSprite(c: RGB, W: number, H: number): Sprite {
  return sprite(`keybloom:${ckey(c)}:${W}x${H}`, W, H, (g) => {
    g.globalAlpha = 0.55;
    g.drawImage(glowSprite(c, 0.35) as CanvasImageSource, 0, 0, W, H);
  });
}

// ---------------------------------------------------------------------------------------------
// per-note sprite sets (numeric keys → no per-frame string or object allocation)
// ---------------------------------------------------------------------------------------------

interface BurstSet {
  burst: (Sprite | null)[];
  streak: Sprite;
  flash: Sprite;
  /** hot cores at HOT_LEVELS quantised sizes (index = level), built lazily */
  hot: (Sprite | null)[];
}
/** key: packed colour * 1024 + R */
const burstSets = new Map<number, BurstSet>();
function burstSet(packed: number, R: number): BurstSet {
  const key = packed * 1024 + R;
  let s = burstSets.get(key);
  if (!s) {
    const c = unpack(packed);
    s = { burst: [null, null, null], streak: streakSprite(c, R), flash: glowSprite(c, 0.5), hot: [] };
    burstSets.set(key, s);
  }
  return s;
}
/** Hot-core size unit for an intensity level (1..HOT_LEVELS): sizes are quantised so the
 *  sustained hot core is an unscaled, integer-aligned blit. */
const HOT_LEVELS = 8;
const hotR = (R: number, level: number) => Math.max(3, Math.round(R * (0.62 + (0.5 * level) / HOT_LEVELS)));
function hotOf(s: BurstSet, R: number, level: number): Sprite {
  return s.hot[level] ?? (s.hot[level] = hotSprite(hotR(R, level)));
}
function burstOf(s: BurstSet, packed: number, variant: number, R: number): Sprite {
  return s.burst[variant] ?? (s.burst[variant] = burstSprite(unpack(packed), variant, R));
}

interface DustSet {
  grain: Sprite;
  core: string[];
  glint: Sprite;
  wisp: Sprite;
}
/** key: packed (quantised) note colour */
const dustSets = new Map<number, DustSet>();
function dustSet(packed: number): DustSet {
  let s = dustSets.get(packed);
  if (!s) {
    const c = unpack(packed);
    const tint = quant(mix(c, WHITE, 0.35));
    s = { grain: grainSprite(tint), core: coreStyles(tint), glint: glintSprite(tint), wisp: wispSprite(c) };
    dustSets.set(packed, s);
  }
  return s;
}

interface KeySet {
  tint: Sprite;
  tintW: number;
  glow: Sprite;
  coneW: number;
  bloom: Sprite;
  bloomW: number;
  bloomH: number;
}
/** key: packed colour * 4096 + key width in 1/8 px; valid for one (kbH, scale) pair */
const keySets = new Map<number, KeySet>();
let keyGeomH = -1;
let keyGeomSc = -1;
function keySet(packed: number, w8: number, h: number, sc: number): KeySet {
  const key = packed * 4096 + w8;
  let s = keySets.get(key);
  if (!s) {
    const c = unpack(packed);
    const kw = w8 / 8; // quantised key width → sprite dims depend only on the key
    const tintW = Math.round(Math.max(kw * 3.2, 40 * sc));
    const coneW = Math.round(Math.max(kw * 4.2, 52 * sc));
    const bloomW = Math.round(Math.max(kw * 5.5, 70 * sc));
    const bloomH = 2 * Math.round(17 * sc);
    s = {
      tint: spillSprite(c, 0, tintW, h),
      tintW,
      glow: keyGlowSprite(c, coneW, h),
      coneW,
      bloom: keyBloomSprite(c, bloomW, bloomH),
      bloomW,
      bloomH,
    };
    keySets.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/**
 * Stable per-note seed (from pitch + onset, so live view and exports agree regardless of ids).
 * Kept below 2^20 so `hash(seed + i, j)` stays within exact double-integer range.
 */
const noteSeed = (n: FxNote) => Math.floor(hash(n.midi * 7 + 3, Math.round(n.start * 1000)) * 0xfffff);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Release envelope after note-off: 1 while sounding, smooth fall to exactly 0 at FX_RELEASE. */
function release(n: FxNote, now: number): number {
  const d = now - n.end;
  if (d < 0) return 1;
  if (d >= FX_RELEASE) return 0;
  return Math.exp(-d / 0.045) * (1 - d / FX_RELEASE);
}

// reusable scratch arrays for drawKeyLight
let actIdx = new Int32Array(64);
let actE = new Float64Array(64);
let actC = new Int32Array(64);

// ---------------------------------------------------------------------------------------------
// key light
// ---------------------------------------------------------------------------------------------

/** Coloured light spilling onto played keys. Drawn AFTER the keyboard. */
export function drawKeyLight(ctx: Ctx2D, notes: FxNote[], now: number, g: FxGeometry, s: EffectSettings): void {
  const k = s.keyLightIntensity;
  const h = Math.round(g.kbH);
  if (k <= 0 || h < 2) return;
  checkBudget();
  const sc = g.scale;
  if (h !== keyGeomH || sc !== keyGeomSc) {
    keySets.clear();
    keyGeomH = h;
    keyGeomSc = sc;
  }
  if (actIdx.length < notes.length) {
    const sz = Math.max(notes.length, actIdx.length * 2);
    actIdx = new Int32Array(sz);
    actE = new Float64Array(sz);
    actC = new Int32Array(sz);
  }
  let na = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.start > now || now >= n.end + FX_RELEASE) continue;
    const age = now - n.start;
    // quick attack, a little overshoot that relaxes to the sustain level, smooth release
    const e =
      (1 - Math.exp(-age / 0.035)) * (0.78 + 0.22 * Math.exp(-age / 0.3)) * (0.7 + 0.3 * n.vel) * k * release(n, now);
    if (e <= 0.004) continue;
    actIdx[na] = i;
    actE[na] = e;
    actC[na] = qpack(n.color);
    na++;
  }
  if (!na) return;
  const top = Math.round(g.hitY);
  ctx.save();
  try {
    // 1) tint the keys (multiply: white keys take on the colour, black keys stay dark)
    ctx.globalCompositeOperation = 'multiply';
    for (let a = 0; a < na; a++) {
      const n = notes[actIdx[a]];
      const ks = keySet(actC[a], Math.min(4095, Math.round(n.w * 8)), h, sc);
      ctx.globalAlpha = clamp01(actE[a] * 1.7);
      ctx.drawImage(ks.tint as CanvasImageSource, Math.round(n.x - ks.tintW / 2), top);
    }
    // 2) add light: the cone (lifts black keys and gaps to the colour) and the top-edge bloom
    ctx.globalCompositeOperation = 'lighter';
    const bloomY = top + Math.round(2 * sc);
    for (let a = 0; a < na; a++) {
      const n = notes[actIdx[a]];
      const ks = keySet(actC[a], Math.min(4095, Math.round(n.w * 8)), h, sc);
      ctx.globalAlpha = clamp01(actE[a]);
      ctx.drawImage(ks.glow as CanvasImageSource, Math.round(n.x - ks.coneW / 2), top);
      ctx.drawImage(ks.bloom as CanvasImageSource, Math.round(n.x - ks.bloomW / 2), bloomY - ks.bloomH / 2);
    }
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// bursts
// ---------------------------------------------------------------------------------------------

/** Starburst flares at the hit line. Drawn after the keyboard (on top). */
export function drawBursts(ctx: Ctx2D, notes: FxNote[], now: number, g: FxGeometry, s: EffectSettings): void {
  const inten = s.burstIntensity;
  if (inten <= 0) return;
  checkBudget();
  const R = Math.min(1023, Math.max(6, Math.round(50 * g.scale))); // flare unit (integer → stable keys)
  const y = g.hitY;
  const up = burstUp(R);
  const iy = Math.round(y);
  ctx.save();
  try {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.start > now || now >= n.end + FX_RELEASE) continue;
      const age = now - n.start;
      const rel = release(n, now);
      if (rel <= 0) continue;
      const seed = noteSeed(n);
      const k = inten * (0.5 + 0.5 * n.vel) * rel;
      // envelope: tiny ramp-in, strong flash that settles into a gently breathing glow
      const ramp = clamp01(age / 0.012);
      const flash = Math.exp(-age / 0.09);
      const shimmer =
        0.94 + 0.04 * Math.sin(now * 11.3 + hash(seed, 1) * 6.28) + 0.02 * Math.sin(now * 23.7 + hash(seed, 2) * 6.28);
      const packed = qpack(n.color);
      const set = burstSet(packed, R);
      const main = burstOf(set, packed, seed % 3, R);
      const streak = set.streak;
      // white-hot heart: scaled by SIZE (quantised levels) so its centre stays white
      const kh = k < 1 ? k : 1;
      const level = Math.max(1, Math.min(HOT_LEVELS, Math.round(kh * HOT_LEVELS)));
      const hot = hotOf(set, R, level);
      const hu = hotUp(hotR(R, level));
      const hw = hot.width;
      const hh = hot.height;
      const mw = main.width;
      const mh = main.height;
      const sw = streak.width;
      const sh = streak.height;
      const ix = Math.round(n.x);

      // sustained flare: unscaled, integer-aligned blits (cheapest path for the rasteriser)
      ctx.globalAlpha = clamp01(ramp * k * 1.3 * shimmer);
      ctx.drawImage(main as CanvasImageSource, ix - (mw >> 1), iy - up);
      ctx.drawImage(streak as CanvasImageSource, ix - (sw >> 1), iy - (sh >> 1));
      ctx.globalAlpha = clamp01(ramp * kh * 2.2);
      ctx.drawImage(hot as CanvasImageSource, ix - (hw >> 1), iy - hu);

      // attack flash: the same flare blown up and brighter, decaying in ~0.1 s
      if (flash > 0.03) {
        const f = ramp * flash * k;
        ctx.globalAlpha = clamp01(f * 0.9);
        const z = 1 + 0.35 * flash;
        ctx.drawImage(main as CanvasImageSource, n.x - (mw * z) / 2, y - up * z, mw * z, mh * z);
        const zf = 1 + 0.3 * flash;
        ctx.drawImage(hot as CanvasImageSource, n.x - (hw * zf) / 2, y - hu * zf, hw * zf, hh * zf);
        const w2 = sw * (1 + 0.9 * flash);
        ctx.drawImage(streak as CanvasImageSource, n.x - w2 / 2, y - sh / 2, w2, sh);
        ctx.globalAlpha = clamp01(f * 0.7);
        const hd = R * (3.2 + 2.2 * flash);
        ctx.drawImage(set.flash as CanvasImageSource, n.x - hd, y - hd * 0.8, hd * 2, hd * 1.6);
      }
    }
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------
// dust
// ---------------------------------------------------------------------------------------------

const DUST_DT = 1 / 30; // emission tick (s)
const DUST_PER_TICK = 3; // drifting stream particles per tick while the note sounds
const DUST_ONSET = 10; // extra particles in the onset puff
const DUST_TAIL = 0.35; // emission continues (thinning) this long after note-off
const DUST_LIFE_MIN = 1.5;
const DUST_LIFE_MAX = 2.6; // TAIL + LIFE_MAX must stay <= DUST_LOOKBACK
const FOUNT_PER_TICK = 5; // short-lived "fountain" sparkles rising steeply from the hit point
const FOUNT_LIFE_MIN = 0.4;
const FOUNT_LIFE_MAX = 0.8;
const DUST_CAP = 800; // max particles drawn per frame
const DUST_LEVELS = 10; // brightness levels of the (cached) grain-core fill styles
const PID_STRIDE = 32; // particle ids per tick: stream j in [0,13), fountain j in [16,21)

const STRANDS = 3;
const strandVx = new Float64Array(STRANDS);
const strandAmp = new Float64Array(STRANDS);
const strandW = new Float64Array(STRANDS);
const strandPh = new Float64Array(STRANDS);
const strandUp = new Float64Array(STRANDS);
const strandPop = new Float64Array(STRANDS);

const WARM_WHITE = quant({ r: 255, g: 244, b: 222 });
const GOLD = quant({ r: 255, g: 206, b: 120 });

/** Glittering dust floating up and drifting from played notes. Drawn last. */
export function drawDust(ctx: Ctx2D, notes: FxNote[], now: number, g: FxGeometry, s: EffectSettings): void {
  const amount = s.dustAmount;
  if (amount <= 0 || !notes.length) return;
  const sc = g.scale;

  // estimate the candidate count to derive a global keep-fraction (nested subsets → no popping
  // when only the budget changes slightly)
  let est = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.start > now) continue;
    const emitEnd = Math.min(now, n.end + DUST_TAIL);
    const from = Math.max(n.start, now - DUST_LIFE_MAX);
    if (emitEnd >= from) est += ((emitEnd - from) / DUST_DT + 1) * DUST_PER_TICK;
    const fEnd = Math.min(now, n.end);
    const fFrom = Math.max(n.start, now - FOUNT_LIFE_MAX);
    if (fEnd >= fFrom) est += ((fEnd - fFrom) / DUST_DT + 1) * FOUNT_PER_TICK * 0.75;
    if (now - n.start < DUST_LIFE_MAX) est += DUST_ONSET;
  }
  est *= amount;
  if (est <= 0) return;
  const keepAll = amount * Math.min(1, DUST_CAP / est);

  checkBudget();
  // Every grain gets a crisp core drawn with fillRect (several times cheaper than drawImage);
  // only a share of them (the bigger / currently twinkling ones) also get a soft glow sprite.
  const warm = grainSprite(WARM_WHITE);
  const gold = grainSprite(GOLD);
  const warmCore = coreStyles(WARM_WHITE);
  const goldCore = coreStyles(GOLD);
  const glWarm = glintSprite(WARM_WHITE);
  const glGold = glintSprite(GOLD);
  const yMin = -10 * sc;
  const xMin = -10 * sc;
  const xMax = g.width + 10 * sc;

  ctx.save();
  try {
    // Plain source-over: on the dark backdrop it looks the same as additive blending for such
    // small, sparse particles, and it is several times cheaper to rasterise in software.
    ctx.globalCompositeOperation = 'source-over';
    let drawn = 0;
    notesLoop: for (let ni = 0; ni < notes.length; ni++) {
      const n = notes[ni];
      if (n.start > now) continue;
      const seed = noteSeed(n);
      const ds = dustSet(qpack(n.color));
      const tinted = ds.grain;
      const tintCore = ds.core;
      const glTint = ds.glint;
      const wisp = ds.wisp;
      const velK = 0.6 + 0.4 * n.vel;
      // per-note stream character: a common drift plus a few strands, each a sinuous path.
      // Grains of one strand share (almost) the same path as a function of their AGE, so a
      // snapshot of the strand traces that path → a wispy filament rather than a uniform cloud.
      const dir = hash(seed, 11) < 0.5 ? -1 : 1;
      const drift = dir * (35 + 70 * hash(seed, 12));
      const bendF = 0.5 + 0.7 * hash(seed, 13);
      const bendP = hash(seed, 14) * 6.283;
      for (let k = 0; k < STRANDS; k++) {
        const sk = seed + k * 101;
        strandVx[k] = drift * (0.7 + 0.6 * hash(sk, 20));
        strandAmp[k] = 14 + 30 * hash(sk, 21);
        strandW[k] = (1.6 + 2.2 * hash(sk, 22)) * (hash(sk, 23) < 0.5 ? -1 : 1);
        strandPh[k] = hash(sk, 24) * 6.283;
        strandUp[k] = 48 + 52 * hash(sk, 25);
        strandPop[k] = 140 + 200 * hash(sk, 26);
      }

      // --- fountain: dense, short-lived sparkles shooting up from the hit point while it sounds
      const fMin = Math.max(0, Math.ceil((now - FOUNT_LIFE_MAX - n.start) / DUST_DT));
      const fMax = Math.floor((Math.min(now, n.end) - n.start) / DUST_DT);
      for (let i = fMin; i <= fMax; i++) {
        const tb = n.start + i * DUST_DT;
        const a = now - tb;
        if (a < 0) continue;
        for (let j = 0; j < FOUNT_PER_TICK; j++) {
          const ps = seed + (i * PID_STRIDE + 16 + j) * 7;
          const r0 = hash(ps, 101);
          if (r0 >= keepAll * velK) continue;
          const r1 = hash(ps, 102);
          const life = FOUNT_LIFE_MIN + (FOUNT_LIFE_MAX - FOUNT_LIFE_MIN) * r1;
          if (a >= life) continue;
          const r2 = hash(ps, 103);
          const r3 = hash(ps, 104);
          const r4 = hash(ps, 105);
          const r5 = hash(ps, 106);
          const p = a / life;
          // steep rise that decelerates; a slight outward spray and a lean into the stream
          const tau = 0.3;
          const v0 = (260 + 440 * r2) * sc;
          const rise = v0 * tau * (1 - Math.exp(-a / tau));
          const spread = (r4 - 0.5) * (40 + 50 * r3) * (1 - Math.exp(-a / 0.25));
          const x = n.x + (r5 - 0.5) * 0.8 * n.w + (spread + drift * 0.35 * a * a) * sc;
          const yy = g.hitY - 4 * sc - rise;
          if (yy < yMin || x < xMin || x > xMax) continue;
          const fade = clamp01(a / 0.03) * Math.pow(1 - p, 1.3);
          const tw = 0.5 + 0.5 * Math.sin(now * (14 + 16 * r2) + r3 * 6.283);
          const twinkle = 0.35 + 0.65 * tw * tw;
          const alpha = fade * (0.7 + 0.5 * twinkle);
          if (alpha < 0.03) continue;
          const size = (1.6 + 2.2 * r3) * sc * (1 - 0.4 * p);
          const ci = r1 * 0.41 + r2 * 0.59 < 0.5 ? 0 : r5 < 0.5 ? 1 : 2;
          if (r5 < 0.3 || twinkle > 0.8) {
            ctx.globalAlpha = clamp01(alpha * 0.9);
            const d = size * 4.4;
            ctx.drawImage((ci === 0 ? warm : ci === 1 ? gold : tinted) as CanvasImageSource, x - d / 2, yy - d / 2, d, d);
          }
          ctx.globalAlpha = 1;
          const level = Math.max(1, Math.min(DUST_LEVELS, Math.round(alpha * DUST_LEVELS)));
          ctx.fillStyle = (ci === 0 ? warmCore : ci === 1 ? goldCore : tintCore)[level];
          const cs = Math.max(1, size * 0.72);
          ctx.fillRect(x - cs / 2, yy - cs / 2, cs, cs);
          if (twinkle > 0.86 && r4 > 0.7) {
            const gd = size * (6 + 4 * r5) * (twinkle - 0.6) * 2.5;
            ctx.globalAlpha = clamp01(fade * (twinkle - 0.7) * 2.6);
            ctx.drawImage((ci === 0 ? glWarm : ci === 1 ? glGold : glTint) as CanvasImageSource, x - gd / 2, yy - gd / 2, gd, gd);
          }
          if (++drawn >= DUST_CAP) break notesLoop;
        }
      }

      // --- drifting streams
      const iMin = Math.max(0, Math.ceil((now - DUST_LIFE_MAX - n.start) / DUST_DT));
      const iMax = Math.floor((Math.min(now, n.end + DUST_TAIL) - n.start) / DUST_DT);
      for (let i = iMin; i <= iMax; i++) {
        const tb = n.start + i * DUST_DT;
        const a = now - tb;
        if (a < 0) continue;
        const tailK = tb > n.end ? 1 - (tb - n.end) / DUST_TAIL : 1;
        const count = i === 0 ? DUST_PER_TICK + DUST_ONSET : DUST_PER_TICK;
        // the whole stream sways slowly with emission time
        const sway = Math.sin(tb * bendF + bendP) * 22;
        for (let j = 0; j < count; j++) {
          const ps = seed + (i * PID_STRIDE + j) * 7;
          const r0 = hash(ps, 101);
          if (r0 >= keepAll * velK * tailK) continue;
          const r1 = hash(ps, 102);
          const life = DUST_LIFE_MIN + (DUST_LIFE_MAX - DUST_LIFE_MIN) * r1;
          if (a >= life) continue;
          const r2 = hash(ps, 103);
          const r3 = hash(ps, 104);
          const r4 = hash(ps, 105);
          const r5 = hash(ps, 106);
          const r6 = hash(ps, 107);
          const p = a / life;
          const onset = i === 0 && j >= DUST_PER_TICK;
          const k = Math.floor(r6 * STRANDS);

          // vertical: an initial pop that decays (tau) plus a slow buoyant float
          const tau = 0.3;
          const v0 = (onset ? 280 + 340 * r2 : strandPop[k] * (0.95 + 0.1 * r2)) * sc;
          const vb = strandUp[k] * (0.96 + 0.08 * r3) * sc;
          const rise = v0 * tau * (1 - Math.exp(-a / tau)) + vb * a;
          // sideways: drift that eases in, a sinuous curl along the strand, slow sway, diffusion
          const ease = a * (0.3 + 0.7 * Math.min(1, a / 0.9));
          const curl = Math.sin(a * strandW[k] + strandPh[k]) * strandAmp[k] * Math.min(1, a * 1.2);
          const diffuse = (onset ? 130 : 4 + 16 * a) * (r4 - 0.5);
          const x0 = n.x + (r5 - 0.5) * n.w * 0.7;
          const x = x0 + ((strandVx[k] + sway) * ease + curl + diffuse) * sc;
          const yy = g.hitY - 3 * sc - rise + (r2 - 0.5) * (3 + 10 * a) * sc;
          if (yy < yMin || x < xMin || x > xMax) continue;

          // fade in/out, shrink, twinkle
          const fade = clamp01(a / 0.08) * Math.pow(1 - p, 1.3);
          const tw = 0.5 + 0.5 * Math.sin(now * (7 + 11 * r2) + r3 * 6.283);
          const twinkle = 0.3 + 0.7 * tw * tw * tw;
          const alpha = fade * (0.5 + 0.6 * twinkle);
          if (alpha < 0.02) continue;
          const size = (1.8 + 2.6 * r3) * sc * (1 - 0.5 * p);
          const pal = r1 * 0.37 + r2 * 0.63; // decorrelated palette pick
          const ci = pal < 0.45 ? 0 : pal < 0.78 ? 1 : 2;
          const level = Math.max(1, Math.min(DUST_LEVELS, Math.round(alpha * DUST_LEVELS)));
          // faint coloured smoke around some grains gives the streams a wispy body
          if (r0 < keepAll * 0.14) {
            const wd = (16 + 18 * r2) * sc * (0.6 + p);
            ctx.globalAlpha = clamp01(fade * 0.2);
            ctx.drawImage(wisp as CanvasImageSource, x - wd / 2, yy - wd / 2, wd, wd);
          }
          // soft glow for the bigger / currently twinkling grains
          if (r5 < 0.3 || twinkle > 0.7) {
            ctx.globalAlpha = clamp01(alpha * 0.85);
            const d = size * 4.2;
            ctx.drawImage((ci === 0 ? warm : ci === 1 ? gold : tinted) as CanvasImageSource, x - d / 2, yy - d / 2, d, d);
          }
          // crisp core
          ctx.globalAlpha = 1;
          ctx.fillStyle = (ci === 0 ? warmCore : ci === 1 ? goldCore : tintCore)[level];
          const cs = Math.max(1, size * 0.72);
          ctx.fillRect(x - cs / 2, yy - cs / 2, cs, cs);
          // occasional bright glint
          if (twinkle > 0.82 && r4 < 0.35) {
            const gl = pal < 0.45 ? glWarm : pal < 0.78 ? glGold : glTint;
            const gd = size * (7 + 5 * r5) * (twinkle - 0.6) * 2.5;
            ctx.globalAlpha = clamp01(fade * (twinkle - 0.7) * 2.6);
            ctx.drawImage(gl as CanvasImageSource, x - gd / 2, yy - gd / 2, gd, gd);
          }
          if (++drawn >= DUST_CAP) break notesLoop;
        }
      }
    }
  } finally {
    ctx.restore();
  }
}
