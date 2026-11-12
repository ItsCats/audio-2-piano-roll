/**
 * Draws one frame of a title page / end card at time t (seconds since it started).
 *
 * Order: background → solid lines and dividers → filled lines and dividers drawn white into a
 * mask layer, coloured there with the pattern / gradient / image (source-atop) plus an optional
 * shine → mask composited with a soft glow → sparkles. Optional slow zoom around the centre.
 * Canvas 2D features only (works on OffscreenCanvas and Safari 16.4+): no ctx.filter, no
 * letterSpacing (letters are placed one by one).
 */
import { hash, makeCanvas, type AnyCanvas, type Ctx2D } from '../color';
import { drawCardBackground, drawCover, drawStar, type CardImages } from './background';
import { adaptLook, regionStats, sourceRect, type LumStats } from './contrast';
import { FLOURISH_BOUNDS, getFlourishPath } from './flourishes';
import { fontEpoch } from './fontEpoch';
import { BELOW_GAP, TRACK_WHOLE, canvasMeasurer, isDigit, layoutTitleCard, splitGraphemes, unionRect, type BlockLayout, type LayoutOptions, type Measurer, type Rect, type TitleLayout } from './layout';
import { getFillTile, patternInfo, tileSizeFor } from './patterns';
import type { FillSpec, ResolvedLook } from './presets';
import type { FillPatternId, TextRole, TitleText } from './types';

const DELAY: Record<TextRole | 'ornament', number> = { title: 0.25, subtitle: 0.55, composer: 0.8, ornament: 0.8, credit: 1.1, small: 1.3 };
const ENTER = 0.9;

export const easeOut = (u: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
const easeInOut = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

export interface DrawOptions {
  /** length of this card in seconds (scales the entrance timing and the slow zoom) */
  duration: number;
  /** draw every element fully shown (static previews) */
  reveal?: boolean;
  /** leave the background transparent (tests) */
  transparent?: boolean;
  layout?: LayoutOptions;
  /** opacity of everything but the background (the title fades out to its background before the roll comes in) */
  content?: number;
}

/** Reusable per-output state: layout, measurer, mask layer and sparkle points. */
export class TitleCardCache {
  key = '';
  layout: TitleLayout | null = null;
  measurer: Measurer | null = null;
  private measureEpoch = -1;
  private scratch: AnyCanvas | null = null;
  mask: AnyCanvas | null = null;
  sparkles: { x: number; y: number; r: number; w: number; p: number; role: TextRole }[] = [];
  private patterns = new Map<string, { size: number; pat: CanvasPattern }>();
  private adapted: { src: ResolvedLook; key: string; out: ResolvedLook } | null = null;
  private lum = new WeakMap<object, Map<string, LumStats>>();

  /** Repeating pattern of a fill tile at a tile size (one per mask context). */
  patternFor(mc: Ctx2D, id: FillPatternId, size: number): { size: number; pat: CanvasPattern } | null {
    const key = `${id}@${size}`;
    let p = this.patterns.get(key);
    if (!p) {
      const tile = getFillTile(id, size);
      const pat = tile ? mc.createPattern(tile as CanvasImageSource, 'repeat') : null;
      if (!pat) return null;
      p = { size, pat };
      this.patterns.set(key, p);
    }
    return p;
  }

  /** Luminance spread of the picture behind the text (cached per picture and text box). */
  photoStats(src: CanvasImageSource, W: number, H: number, box: Rect, cover: boolean): LumStats {
    let m = this.lum.get(src as object);
    if (!m) this.lum.set(src as object, (m = new Map()));
    const key = [W, H, box.x0, box.y0, box.x1, box.y1, cover].map((v) => (typeof v === 'number' ? Math.round(v) : v)).join(',');
    let v = m.get(key);
    if (!v) {
      v = regionStats(src, sourceRect(src, W, H, pad(box, 0.04 * W, 0.04 * H), cover));
      if (m.size > 20) m.clear();
      m.set(key, v);
    }
    return v;
  }

  /** The look adapted to a picture background (memoised per look and brightness). */
  adapt(look: ResolvedLook, st: LumStats): ResolvedLook {
    const q = (x: number) => Math.round(x * 100) / 100;
    const k = `${q(st.median)},${q(st.lo)},${q(st.hi)}`;
    if (this.adapted && this.adapted.src === look && this.adapted.key === k) return this.adapted.out;
    const out = adaptLook(look, st.median, { median: q(st.median), lo: q(st.lo), hi: q(st.hi) });
    this.adapted = { src: look, key: k, out };
    return out;
  }

  getMeasurer(): Measurer {
    if (!this.measurer || this.measureEpoch !== fontEpoch()) {
      this.scratch ??= makeCanvas(8, 8);
      this.measurer = canvasMeasurer(this.scratch.getContext('2d') as Ctx2D);
      this.measureEpoch = fontEpoch();
      this.key = '';
    }
    return this.measurer;
  }

  getMask(W: number, H: number): { c: AnyCanvas; ctx: Ctx2D } {
    if (!this.mask || this.mask.width !== W || this.mask.height !== H) {
      this.mask = makeCanvas(W, H);
      this.patterns.clear();
    }
    return { c: this.mask, ctx: this.mask.getContext('2d') as Ctx2D };
  }

  dispose(): void {
    if (this.mask) {
      this.mask.width = 1;
      this.mask.height = 1;
    }
    this.mask = null;
    this.patterns.clear();
    this.layout = null;
  }
}

export function getLayout(W: number, H: number, look: ResolvedLook, text: TitleText, cache: TitleCardCache, opts?: LayoutOptions): TitleLayout {
  const m = cache.getMeasurer();
  // geometry only (colours don't move anything, so a contrast change keeps the cached layout)
  const lines = Object.fromEntries(Object.entries(look.lines).map(([r, l]) => [r, { ...l, color: '' }]));
  const key = JSON.stringify([W, H, lines, look.divider, look.ruleStyle, look.fillRoles, text, opts ?? null, fontEpoch()]);
  if (cache.key !== key || !cache.layout) {
    cache.layout = layoutTitleCard(W, H, look, text, m, opts);
    cache.key = key;
    cache.sparkles = sparklePoints(cache.layout, look);
  }
  return cache.layout;
}

function sparklePoints(L: TitleLayout, look: ResolvedLook) {
  const roles = look.fillRoles.length ? look.fillRoles : (['title'] as TextRole[]);
  const blocks = L.blocks.filter((b) => b.lines.length && roles.includes(b.role as TextRole));
  if (!blocks.length) return [];
  const slots: { b: BlockLayout; i: number; w: number }[] = [];
  for (const b of blocks) b.lines.forEach((_, i) => slots.push({ b, i, w: b.lineWidths[i] * (b.role === 'title' ? 1 : 0.6) }));
  const total = slots.reduce((a, s) => a + s.w, 0);
  const n = 15;
  const out: TitleCardCache['sparkles'] = [];
  for (let j = 0; j < n; j++) {
    let u = hash(4401, j) * total;
    const s = slots.find((x) => (u -= x.w) <= 0) ?? slots[slots.length - 1];
    const lw = s.b.lineWidths[s.i];
    out.push({
      x: L.W / 2 + (hash(4402, j) - 0.5) * lw * 0.96,
      // along the tops of the capitals (catching the light at the edges, not over the strokes)
      y: s.b.baselines[s.i] - s.b.cap * (0.88 + hash(4403, j) * 0.22),
      r: L.H * 0.011 * (0.55 + hash(4404, j) * 0.7),
      w: 1.3 + hash(4405, j) * 1.4,
      p: hash(4406, j) * Math.PI * 2,
      role: s.b.role as TextRole,
    });
  }
  return out;
}

/** Draws one line of a block centred at cx with baseline y (letters placed one by one when tracked). */
function drawLine(c: Ctx2D, m: Measurer, b: BlockLayout, line: string, cx: number, y: number, track: number): void {
  if (track < TRACK_WHOLE || !b.spec) {
    c.font = b.font;
    const ws = b.spec?.wordSpace ?? 0;
    if (!ws || !line.includes(' ')) {
      c.textAlign = 'center';
      c.fillText(line, cx, y);
      return;
    }
    // words drawn one by one with the extra word space (script joins stay inside each word)
    const words = line.split(' ');
    const space = m.width(b.font, ' ') + ws * b.px;
    const ww = words.map((w) => m.width(b.font, w));
    let x = cx - (ww.reduce((a, w) => a + w, 0) + space * (words.length - 1)) / 2;
    c.textAlign = 'left';
    words.forEach((w, i) => {
      if (w) c.fillText(w, x, y);
      x += ww[i] + space;
    });
    return;
  }
  const gs = splitGraphemes(line);
  const widths = gs.map((g) => m.width(b.digitsFont && isDigit(g) ? b.digitsFont : b.font, g));
  const total = widths.reduce((a, w) => a + w, 0) + track * b.px * Math.max(0, gs.length - 1);
  let x = cx - total / 2;
  c.textAlign = 'left';
  let cur = '';
  gs.forEach((g, i) => {
    const f = b.digitsFont && isDigit(g) ? b.digitsFont : b.font;
    if (f !== cur) {
      c.font = f;
      cur = f;
    }
    if (g !== ' ') c.fillText(g, x, y);
    x += widths[i] + track * b.px;
  });
}

/** The letter spacing while it eases in (Modern), never wider than the safe area allows. */
function animatedTrack(m: Measurer, b: BlockLayout, L: TitleLayout, a: number): number {
  const want = b.track * (1 + 0.4 * (1 - a));
  let maxTrack = want;
  b.lines.forEach((line) => {
    const gs = splitGraphemes(line);
    if (gs.length < 2) return;
    const glyphs = gs.reduce((s, g) => s + m.width(b.digitsFont && isDigit(g) ? b.digitsFont : b.font, g), 0);
    maxTrack = Math.min(maxTrack, (L.safe.x1 - L.safe.x0 - glyphs) / (b.px * (gs.length - 1)));
  });
  return Math.max(b.track, maxTrack);
}

function drawDivider(c: Ctx2D, b: BlockLayout, L: TitleLayout, color: string, grow: number): void {
  const d = b.divider;
  if (!d || grow <= 0) return;
  const cx = L.W / 2;
  c.save();
  c.fillStyle = color;
  if (d.kind === 'vine' || d.kind === 'scroll') {
    const f = FLOURISH_BOUNDS[d.kind];
    const path = getFlourishPath(d.kind);
    const fw = f.maxX - f.minX;
    for (const s of [-1, 1]) {
      c.save();
      if (d.mode === 'side') {
        const x0 = cx + s * d.inner;
        // draw on from the inner end outwards
        const rw = fw * d.em * grow + d.em * 0.3;
        c.beginPath();
        c.rect(s < 0 ? x0 - rw : x0 - d.em * 0.3, d.cy - d.em * 2, rw + d.em * 0.3, d.em * 4);
        c.clip();
        c.translate(x0, d.cy);
        c.scale(s < 0 ? d.em : -d.em, d.em);
      } else {
        // mirrored pair whose inner ends meet at the centre, drawn on from the centre outwards
        // (the clip covers the whole ornament once it has grown: d.len is its full half width)
        const rw = d.len * grow + (grow >= 1 ? d.em : 0);
        c.beginPath();
        c.rect(s < 0 ? cx - rw : cx, d.cy - d.em * 2, rw, d.em * 4);
        c.clip();
        c.translate(cx + s * (BELOW_GAP + f.maxX) * d.em, d.cy - ((f.maxY + f.minY) / 2) * d.em);
        c.scale(s < 0 ? d.em : -d.em, d.em);
      }
      c.fill(path);
      c.restore();
    }
  } else {
    const th = d.thick;
    const diamond = d.kind === 'diamond';
    const ds = diamond ? Math.max(th * 2, 0.18 * d.em * 0.75) : 0;
    if (d.mode === 'side') {
      for (const s of [-1, 1]) {
        const len = d.len * grow;
        const x0 = cx + s * d.inner;
        const x1 = x0 + s * len;
        const xe = x1 - s * ds;
        if (d.accent) {
          const g = c.createLinearGradient(x0, 0, x0 + s * d.len, 0);
          g.addColorStop(0, color);
          g.addColorStop(1, transparentOf(color));
          c.fillStyle = g;
        }
        c.fillRect(Math.min(x0, xe), d.cy - th / 2, Math.abs(xe - x0), th);
        if (diamond) diamondAt(c, xe, d.cy, ds * Math.min(1, grow * 1.5));
      }
    } else {
      const len = d.len * grow;
      c.fillRect(cx - len, d.cy - th / 2, len * 2, th);
      if (diamond) diamondAt(c, cx, d.cy, ds * grow);
    }
  }
  c.restore();
}

function transparentOf(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
  }
  return color.replace(/rgba?\(([^,]+),([^,]+),([^,)]+)(,[^)]+)?\)/, 'rgba($1,$2,$3,0)');
}

function diamondAt(c: Ctx2D, x: number, y: number, r: number) {
  if (r <= 0) return;
  c.beginPath();
  c.moveTo(x - r, y);
  c.lineTo(x, y - r);
  c.lineTo(x + r, y);
  c.lineTo(x, y + r);
  c.closePath();
  c.fill();
}

function metallicGradient(c: Ctx2D, r: Rect, stops: [number, string][]): CanvasGradient {
  const h = r.y1 - r.y0;
  const g = c.createLinearGradient(r.x0, r.y0 - h, r.x1, r.y1 + h);
  for (const [o, col] of stops) g.addColorStop(o, col);
  return g;
}

/** A filled element in the mask: its box and its capital height (patterns are scaled to it). */
interface MaskBox {
  r: Rect;
  cap: number;
}

/** A pattern tile is this many capital heights wide, so the print reads at every text size. */
const TILE_CAPS = 3.4;

/** Colours the white mask (source-atop) with the fill. */
function paintFill(mc: Ctx2D, fill: FillSpec, boxes: MaskBox[], union: Rect, images: CardImages, cache: TitleCardCache, t: number): void {
  if (fill.kind === 'image') {
    if (images.fillImage) {
      drawCover(mc, images.fillImage, union.x0, union.y0, union.x1 - union.x0, union.y1 - union.y0);
      return;
    }
    paintFill(mc, fill.fallback, boxes, union, images, cache, t);
    return;
  }
  if (fill.kind === 'gradient') {
    const a = (fill.angle * Math.PI) / 180;
    const cx = (union.x0 + union.x1) / 2;
    const cy = (union.y0 + union.y1) / 2;
    const L = Math.abs(((union.x1 - union.x0) / 2) * Math.cos(a)) + Math.abs(((union.y1 - union.y0) / 2) * Math.sin(a)) || 1;
    const g = mc.createLinearGradient(cx - L * Math.cos(a), cy - L * Math.sin(a), cx + L * Math.cos(a), cy + L * Math.sin(a));
    g.addColorStop(0, fill.c0);
    g.addColorStop(1, fill.c1);
    mc.fillStyle = g;
    mc.fillRect(union.x0, union.y0, union.x1 - union.x0, union.y1 - union.y0);
    return;
  }
  if (fill.kind === 'solid') {
    mc.fillStyle = fill.color ?? '#ffffff';
    mc.fillRect(union.x0, union.y0, union.x1 - union.x0, union.y1 - union.y0);
    return;
  }
  const info = patternInfo(fill.id);
  if (info.stops) {
    // one foil sweep per line / divider, so every element shows the full shine
    for (const { r } of boxes) {
      mc.fillStyle = metallicGradient(mc, r, info.stops);
      mc.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    }
    return;
  }
  for (const { r, cap } of boxes) {
    const tileW = Math.max(24, cap * TILE_CAPS);
    const pat = cache.patternFor(mc, fill.id, tileSizeFor(tileW));
    if (!pat) continue;
    const sc = tileW / pat.size;
    const drift = t * 0.05 * tileW;
    mc.save();
    mc.translate(-drift, -drift * 0.4);
    mc.scale(sc, sc);
    mc.fillStyle = pat.pat;
    mc.fillRect((r.x0 + drift) / sc, (r.y0 + drift * 0.4) / sc, (r.x1 - r.x0) / sc, (r.y1 - r.y0) / sc);
    mc.restore();
  }
}

const pad = (r: Rect, px: number, py = px): Rect => ({ x0: r.x0 - px, y0: r.y0 - py, x1: r.x1 + px, y1: r.y1 + py });

/**
 * A soft-edged patch behind the text block (busy pictures): a flat core over the text and
 * feathered edges, built from gradients (no ctx.filter / large shadow blurs).
 */
function drawScrim(ctx: Ctx2D, r: Rect, sc: { rgb: string; alpha: number }, a: number, W: number, H: number): void {
  const al = sc.alpha * a;
  if (al <= 0) return;
  const f = 0.2 * Math.min(W, H);
  const x0 = r.x0 + 0.02 * W;
  const x1 = Math.max(x0, r.x1 - 0.02 * W);
  const y0 = r.y0;
  const y1 = Math.max(y0, r.y1);
  const on = `rgba(${sc.rgb},${al})`;
  const off = `rgba(${sc.rgb},0)`;
  ctx.save();
  ctx.fillStyle = on;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const edge = (gx0: number, gy0: number, gx1: number, gy1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, on);
    g.addColorStop(1, off);
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  };
  edge(x0, 0, x0 - f, 0, x0 - f, y0, f, y1 - y0);
  edge(x1, 0, x1 + f, 0, x1, y0, f, y1 - y0);
  edge(0, y0, 0, y0 - f, x0, y0 - f, x1 - x0, f);
  edge(0, y1, 0, y1 + f, x0, y1, x1 - x0, f);
  for (const [cx, cy, sx, sy] of [
    [x0, y0, -1, -1],
    [x1, y0, 1, -1],
    [x0, y1, -1, 1],
    [x1, y1, 1, 1],
  ]) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, f);
    g.addColorStop(0, on);
    g.addColorStop(1, off);
    ctx.fillStyle = g;
    ctx.fillRect(sx < 0 ? cx - f : cx, sy < 0 ? cy - f : cy, f, f);
  }
  ctx.restore();
}

/** The picture behind the card when it is a photo / the video's background (for contrast). */
function photoOf(look: ResolvedLook, images: CardImages): { src: CanvasImageSource; dim: number; cover: boolean } | null {
  if (look.bg.kind === 'image' && images.bgImage) return { src: images.bgImage, dim: look.bg.dim, cover: true };
  if (look.bg.kind === 'video' && images.backdrop) return { src: images.backdrop, dim: look.bg.dim, cover: false };
  return null;
}

export function drawTitleCard(ctx: Ctx2D, W: number, H: number, lookIn: ResolvedLook, text: TitleText, images: CardImages, t: number, cache: TitleCardCache, opts: DrawOptions): TitleLayout {
  const photo = photoOf(lookIn, images);
  let look = lookIn;
  if (photo) {
    // judge the picture where the text is (the layout doesn't depend on colours)
    const st = cache.photoStats(photo.src, W, H, getLayout(W, H, lookIn, text, cache, opts.layout).content, photo.cover);
    const k = 1 - photo.dim;
    look = cache.adapt(lookIn, { median: st.median * k, lo: st.lo * k, hi: st.hi * k });
  }
  const L = getLayout(W, H, look, text, cache, opts.layout);
  const m = cache.getMeasurer();
  const D = Math.max(0.5, opts.duration);
  const ds = Math.min(1, D / 4);
  const reveal = !!opts.reveal;
  const content = Math.max(0, Math.min(1, opts.content ?? 1));
  const alphaOf = (role: TextRole | 'ornament') => content * (reveal ? 1 : easeOut((t - DELAY[role] * ds) / ENTER));
  const grow = reveal ? 1 : easeOut((t - 0.8 * ds) / 1.1);
  const masked = look.fill.kind !== 'solid';
  const textBoxes = L.blocks.flatMap((b) => [b.box, ...(b.divider?.boxes ?? [])]).map((r) => pad(r, 0.012 * H));

  ctx.save();
  if (look.zoom) {
    const z = 1 + 0.035 * easeInOut(t / D);
    ctx.translate(W / 2, H / 2);
    ctx.scale(z, z);
    ctx.translate(-W / 2, -H / 2);
  }
  if (opts.transparent) ctx.clearRect(0, 0, W, H);
  else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = reveal ? 1 : Math.min(1, Math.max(0, t / 0.6));
    drawCardBackground(ctx, W, H, look.bg, images, { streaks: look.streaks, stars: look.stars, vignette: look.styleBg, avoid: textBoxes }, t);
    ctx.globalAlpha = 1;
  }
  if (content <= 0) {
    ctx.restore();
    return L;
  }
  if (look.scrim && !opts.transparent) drawScrim(ctx, L.content, look.scrim, reveal ? content : alphaOf('title'), W, H);

  let mc: Ctx2D | null = null;
  let mask: AnyCanvas | null = null;
  const maskBoxes: MaskBox[] = [];
  if (masked) {
    const mm = cache.getMask(W, H);
    mask = mm.c;
    mc = mm.ctx;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.globalCompositeOperation = 'source-over';
    mc.globalAlpha = 1;
    mc.clearRect(0, 0, W, H);
  }
  const halo = (c: Ctx2D, h: { color: string; blur: number } | null) => {
    if (!h || opts.transparent) return;
    c.shadowColor = h.color;
    c.shadowBlur = h.blur * H;
  };

  for (const b of L.blocks) {
    const a = alphaOf(b.role);
    if (a <= 0) continue;
    const rise = (1 - a / content) * 0.012 * H;
    const inFill = b.role !== 'ornament' && look.fillRoles.includes(b.role as TextRole);
    const textTarget = masked && inFill ? mc! : ctx;
    if (b.lines.length && b.spec) {
      const track = look.trackEase && b.role === 'title' && !reveal ? animatedTrack(m, b, L, a / content) : b.track;
      textTarget.save();
      textTarget.globalAlpha = a;
      textTarget.textBaseline = 'alphabetic';
      // colour from the look (the cached layout may come from the look before contrast changes)
      textTarget.fillStyle = textTarget === mc ? '#ffffff' : (look.lines[b.role as TextRole]?.color ?? b.spec.color);
      if (textTarget === ctx) halo(ctx, look.textHalo);
      b.lines.forEach((line, i) => drawLine(textTarget, m, b, line, L.W / 2, b.baselines[i] + rise, track));
      textTarget.restore();
      if (textTarget === mc) {
        const maxG = Math.max(...b.lines.map((l) => splitGraphemes(l).length));
        const extra = track > b.track ? ((track - b.track) * b.px * maxG) / 2 : 0;
        maskBoxes.push({ r: pad({ ...b.box, y1: b.box.y1 + rise }, b.px * 0.15 + extra, b.cap * 0.35), cap: b.cap });
      }
    }
    if (b.divider) {
      const divTarget = masked && look.fillDividers ? mc! : ctx;
      const da = b.role === 'ornament' ? a : alphaOf('composer');
      divTarget.save();
      divTarget.globalAlpha = da;
      divTarget.translate(0, rise);
      if (divTarget === ctx) halo(ctx, look.textHalo);
      drawDivider(divTarget, b, L, divTarget === mc ? '#ffffff' : look.dividerColor, grow);
      divTarget.restore();
      if (divTarget === mc) for (const r of b.divider.boxes) maskBoxes.push({ r: pad({ ...r, y1: r.y1 + rise }, b.divider.em * 0.3, b.divider.em * 0.3), cap: b.divider.em * 0.7 });
    }
  }

  if (mc && mask && maskBoxes.length) {
    const union = unionRect(maskBoxes.map((x) => x.r));
    mc.save();
    mc.globalCompositeOperation = 'source-atop';
    paintFill(mc, look.fill, maskBoxes, union, images, cache, t);
    // contrast toning inside the letters only (source-atop keeps the letter shapes)
    if (look.fillTone !== 'none') {
      mc.fillStyle = look.fillTone === 'lift' ? 'rgba(255,255,255,0.28)' : 'rgba(58,42,78,0.42)';
      mc.fillRect(union.x0, union.y0, union.x1 - union.x0, union.y1 - union.y0);
    }
    if (look.shine && !reveal) {
      const u = (t - 1.2 * ds) / (1.2 * ds);
      if (u > 0 && u < 1) {
        const bw = 0.12 * W;
        const xc = union.x0 - bw + u * (union.x1 - union.x0 + 2 * bw);
        const yc = (union.y0 + union.y1) / 2;
        const th = (25 * Math.PI) / 180;
        const vx = Math.cos(th) * (bw / 2);
        const vy = Math.sin(th) * (bw / 2);
        const g = mc.createLinearGradient(xc - vx, yc - vy, xc + vx, yc + vy);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        mc.fillStyle = g;
        mc.fillRect(union.x0, union.y0, union.x1 - union.x0, union.y1 - union.y0);
      }
    }
    mc.restore();
    const shadow = look.halo ?? look.glow;
    const blur = shadow ? shadow.blur * H : 0;
    const r = pad(union, blur * 2);
    const x0 = Math.max(0, Math.floor(r.x0));
    const y0 = Math.max(0, Math.floor(r.y0));
    const x1 = Math.min(W, Math.ceil(r.x1));
    const y1 = Math.min(H, Math.ceil(r.y1));
    if (x1 > x0 && y1 > y0) {
      ctx.save();
      if (shadow && !opts.transparent) {
        ctx.shadowColor = shadow.color;
        ctx.shadowBlur = blur;
      }
      ctx.drawImage(mask as CanvasImageSource, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
  }

  if (look.sparkles && !opts.transparent) {
    // light only ('lighter' can never darken the letters under a fading sparkle)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const sp of cache.sparkles) {
      const a = alphaOf(sp.role);
      if (a <= 0) continue;
      const tw = Math.max(0, Math.sin(t * sp.w + sp.p)) ** 3;
      drawStar(ctx, sp.x, sp.y, sp.r, a * tw * 0.8);
    }
    ctx.restore();
  }
  ctx.restore();
  return L;
}
