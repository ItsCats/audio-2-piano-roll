/**
 * Title page layout: pure geometry from the output size, the resolved look and the text.
 * Text is measured through a `Measurer` (Canvas measureText in the browser, a fake one in unit
 * tests), so the same code decides line breaks, sizes and positions for preview and export.
 *
 * Units: B (base unit) = min(H, 0.8 W) for landscape/square, W for portrait. Sizes in presets
 * are fractions of B; k is a global fit factor (< 1 only when the whole stack is too tall).
 */
import { fontCss, type LineSpec, type ResolvedLook } from './presets';
import { FLOURISH_BOUNDS } from './flourishBounds';
import type { DividerId, TextRole, TitleText } from './types';

export interface Measurer {
  /** advance width of `s` in CSS font `font` */
  width(font: string, s: string): number;
  /** ink above / below the alphabetic baseline */
  extent(font: string, s: string): { asc: number; desc: number };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DividerLayout {
  kind: DividerId;
  /** beside the composer (left + right), or one centred ornament below it / between groups */
  mode: 'side' | 'below';
  /** flourish em in px (flourishes), rule length (rules, per side or half-length below) */
  em: number;
  len: number;
  /** inner end distance from the centre line, per side (side mode) */
  inner: number;
  /** vertical centre of the divider */
  cy: number;
  /** rule thickness */
  thick: number;
  /** short rule fading outwards (Modern) */
  accent?: boolean;
  boxes: Rect[];
}

export type BlockRole = TextRole | 'ornament';

export interface BlockLayout {
  role: BlockRole;
  lines: string[];
  spec: LineSpec | null;
  font: string;
  /** font for digits (old-style figure fix), or null */
  digitsFont: string | null;
  px: number;
  /** letter spacing in em */
  track: number;
  cap: number;
  lineGap: number;
  /** y of the first line's cap top */
  top: number;
  baselines: number[];
  lineWidths: number[];
  textW: number;
  /** text box (cap top of first line → baseline of last, plus script ascenders / descenders) */
  box: Rect;
  divider: DividerLayout | null;
}

export interface TitleLayout {
  W: number;
  H: number;
  B: number;
  k: number;
  portrait: boolean;
  safe: Rect;
  blocks: BlockLayout[];
  /** union of all boxes */
  content: Rect;
}

export interface LayoutOptions {
  /** per-role size multipliers (the end card's main line is a smaller "title") */
  sizeMul?: Partial<Record<TextRole, number>>;
}

const GAPS: Record<string, number> = {
  'title>subtitle': 0.05,
  'subtitle>composer': 0.115,
  'title>composer': 0.125,
  'composer>credit': 0.19,
  'composer>small': 0.19,
  'subtitle>credit': 0.17,
  'title>credit': 0.17,
  'subtitle>small': 0.17,
  'title>small': 0.17,
  'credit>small': 0.045,
  'title>ornament': 0.075,
  'subtitle>ornament': 0.075,
  'ornament>credit': 0.12,
  'ornament>small': 0.12,
};
const DEFAULT_GAP = 0.12;

const MAIN_ROLES: TextRole[] = ['title', 'subtitle', 'composer'];
const ORDER: TextRole[] = ['title', 'subtitle', 'composer', 'credit', 'small'];

const segmenter: { segment(s: string): Iterable<{ segment: string }> } | null = (() => {
  try {
    const S = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    return S ? new S(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    return null;
  }
})();

/** User-perceived characters (keeps accents, emoji and flags together). */
export function splitGraphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

const CASELESS = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
export const isDigit = (g: string) => g >= '0' && g <= '9' && g.length === 1;

/** Below this letter spacing a line is drawn as one string (keeps script joins and ligatures). */
export const TRACK_WHOLE = 0.02;

/**
 * Width of a line drawn one grapheme at a time with `track` em between glyphs (no trailing space),
 * or as one string when the tracking is negligible.
 */
export function trackedWidth(m: Measurer, font: string, digitsFont: string | null, s: string, px: number, track: number): number {
  if (track < TRACK_WHOLE) return m.width(font, s);
  const gs = splitGraphemes(s);
  let w = 0;
  for (const g of gs) w += m.width(digitsFont && isDigit(g) ? digitsFont : font, g);
  return w + track * px * Math.max(0, gs.length - 1);
}

/**
 * Break `widths.length` tokens into `n` consecutive lines minimising the widest line, where a
 * line's width is the sum of its token widths plus `joiner` between tokens plus `lineConst`.
 * Returns the start index of every line. Exact (dynamic programming).
 */
export function balancedBreaks(widths: number[], n: number, joiner: number, lineConst = 0): number[] {
  const T = widths.length;
  if (n <= 1 || T <= 1) return [0];
  n = Math.min(n, T);
  const pre = [0];
  for (const w of widths) pre.push(pre[pre.length - 1] + w);
  const lineW = (a: number, b: number) => pre[b] - pre[a] + (b - a - 1) * joiner + lineConst; // tokens a..b-1
  // best[k][i]: min widest for the first i tokens in k lines; from[k][i]: start of the last line
  const best: number[][] = [];
  const from: number[][] = [];
  for (let k = 0; k <= n; k++) {
    best.push(new Array(T + 1).fill(Infinity));
    from.push(new Array(T + 1).fill(0));
  }
  for (let i = 1; i <= T; i++) best[1][i] = lineW(0, i);
  for (let k = 2; k <= n; k++) {
    for (let i = k; i <= T; i++) {
      for (let j = k - 1; j < i; j++) {
        const v = Math.max(best[k - 1][j], lineW(j, i));
        if (v < best[k][i] - 1e-9) {
          best[k][i] = v;
          from[k][i] = j;
        }
      }
    }
  }
  const starts: number[] = [];
  let i = T;
  for (let k = n; k >= 1; k--) {
    const j = k === 1 ? 0 : from[k][i];
    starts.unshift(j);
    i = j;
  }
  return starts;
}

interface FitResult {
  lines: string[];
  px: number;
  track: number;
}

/** Choose line breaks, tracking and size so the text fits `maxW`. */
function fitLine(m: Measurer, spec: LineSpec, str: string, px0: number, maxW: number, maxLines: number, accept: number): FitResult {
  const font0 = fontCss(spec, px0);
  const dig0 = spec.digits ? fontCss({ font: spec.digits, weight: spec.weight }, px0) : null;
  const tracked = spec.track >= TRACK_WHOLE;
  const width = (s: string, px: number, track: number) => {
    const f = px === px0 ? font0 : fontCss(spec, px);
    const d = spec.digits ? (px === px0 ? dig0 : fontCss({ font: spec.digits, weight: spec.weight }, px)) : null;
    return trackedWidth(m, f, d, s, px, track);
  };

  const words = str.split(/\s+/).filter(Boolean);
  const one = width(str, px0, spec.track);
  let lines = [str];
  let scale = Math.min(1, maxW / Math.max(1e-6, one));
  if (scale < accept) {
    // tokens: words, or graphemes for a single long word / text without spaces (CJK)
    const graphemeTokens = words.length <= 1 || (CASELESS.test(str) && words.length < 3);
    const tokens = graphemeTokens ? splitGraphemes(str.replace(/\s+/g, ' ')) : words;
    const joinStr = graphemeTokens ? '' : ' ';
    const trackPx = tracked ? spec.track * px0 : 0;
    const tokW = tokens.map((t) => width(t, px0, spec.track) + trackPx);
    const joiner = graphemeTokens ? 0 : m.width(font0, ' ') + trackPx;
    const limit = Math.min(maxLines, tokens.length);
    for (let n = 2; n <= limit; n++) {
      const starts = balancedBreaks(tokW, n, joiner, -trackPx);
      const l = starts.map((s, i) => tokens.slice(s, starts[i + 1] ?? tokens.length).join(joinStr).trim()).filter(Boolean);
      const widest = Math.max(...l.map((x) => width(x, px0, spec.track)));
      const s = Math.min(1, maxW / Math.max(1e-6, widest));
      if (s > scale + 0.04) {
        lines = l;
        scale = s;
      }
      if (s >= accept) break;
    }
  }
  let px = px0;
  let track = spec.track;
  if (scale < 1) {
    // tighten the letter spacing first (down to 60 %), then shrink
    track = Math.max(spec.track * 0.6, spec.track * scale);
    for (let pass = 0; pass < 4; pass++) {
      const widest = Math.max(...lines.map((x) => width(x, px, track)));
      if (widest <= maxW) break;
      px *= (maxW / widest) * (pass ? 0.995 : 1);
    }
  }
  return { lines, px, track };
}

const gapKey = (a: BlockRole, b: BlockRole) => GAPS[`${a}>${b}`] ?? DEFAULT_GAP;

export function layoutTitleCard(W: number, H: number, look: ResolvedLook, text: TitleText, m: Measurer, opts: LayoutOptions = {}): TitleLayout {
  const portrait = H > W * 1.2;
  const safe: Rect = portrait
    ? { x0: 0.08 * W, x1: W - 0.08 * W, y0: 0.1 * H, y1: H - 0.16 * H }
    : { x0: 0.07 * W, x1: W - 0.07 * W, y0: 0.08 * H, y1: H - 0.08 * H };
  const safeW = safe.x1 - safe.x0;
  const safeH = safe.y1 - safe.y0;
  const B = portrait ? W : Math.min(H, 0.8 * W);
  const gapMul = portrait ? 1.35 : 1;
  const cx = W / 2;
  const flourish = look.divider === 'vine' || look.divider === 'scroll' ? FLOURISH_BOUNDS[look.divider] : null;
  const fw = flourish ? flourish.maxX - flourish.minX : 0;
  const emMul = look.divider === 'scroll' ? 1.6 : 1.3;

  const present = ORDER.filter((r) => text[r] && text[r].trim());
  let k = 1;
  let result: TitleLayout | null = null;
  for (let pass = 0; pass < 5; pass++) {
    const blocks: BlockLayout[] = [];
    const thick = Math.max(1, 0.0016 * B * k);
    for (const role of present) {
      const spec = look.lines[role];
      const raw = text[role].trim().replace(/\s+/g, ' ');
      const str = spec.upper && !CASELESS.test(raw) ? raw.toLocaleUpperCase() : raw;
      const px0 = spec.size * B * k * (opts.sizeMul?.[role] ?? 1);
      const maxLines = role === 'title' ? (portrait ? 4 : 3) : 2;
      const accept = role === 'title' ? (portrait ? 0.95 : 0.82) : role === 'composer' ? 0.58 : 0.62;
      const fit = fitLine(m, spec, str, px0, safeW, maxLines, accept);
      const font = fontCss(spec, fit.px);
      const digitsFont = spec.digits ? fontCss({ font: spec.digits, weight: spec.weight }, fit.px) : null;
      const lineWidths = fit.lines.map((l) => trackedWidth(m, font, digitsFont, l, fit.px, fit.track));
      const textW = Math.max(...lineWidths);
      const capH = spec.upper ? m.extent(font, 'H').asc || fit.px * 0.7 : fit.px * 0.75;
      const lineGap = spec.upper ? capH * 0.72 : fit.px * 0.42;
      let ascExtra = 0;
      let descExtra = 0;
      if (!spec.upper) {
        const first = m.extent(font, fit.lines[0]);
        const last = m.extent(font, fit.lines[fit.lines.length - 1]);
        ascExtra = Math.max(0, first.asc - capH);
        descExtra = Math.max(0, last.desc);
      }
      const baselines = fit.lines.map((_, i) => ascExtra + capH + i * (capH + lineGap));
      const textH = ascExtra + fit.lines.length * capH + (fit.lines.length - 1) * lineGap + descExtra;
      const block: BlockLayout = {
        role,
        lines: fit.lines,
        spec,
        font,
        digitsFont,
        px: fit.px,
        track: fit.track,
        cap: capH,
        lineGap,
        top: 0,
        baselines,
        lineWidths,
        textW,
        box: { x0: cx - textW / 2, x1: cx + textW / 2, y0: 0, y1: textH },
        divider: null,
      };
      if (role === 'composer' && look.divider !== 'none') {
        const em = fit.px;
        const gap = em * 0.9;
        const side = (safeW - textW) / 2 - gap;
        const lastBase = baselines[baselines.length - 1];
        if (flourish) {
          const natural = fw * em * emMul;
          if (fit.lines.length === 1 && side >= natural * 0.6) {
            const fem = Math.min(em * emMul, side / fw);
            const inner = textW / 2 + gap * 0.8;
            const cy = lastBase - capH / 2;
            block.divider = {
              kind: look.divider,
              mode: 'side',
              em: fem,
              len: fw * fem,
              inner,
              cy,
              thick,
              boxes: [-1, 1].map((s) => sideBox(cx, s, inner - flourish.maxX * fem, inner - flourish.minX * fem, cy + flourish.minY * fem, cy + flourish.maxY * fem)),
            };
          } else {
            block.divider = belowFlourish(cx, lastBase + capH * 0.9, Math.min(safeW * 0.36, natural), flourish, look.divider, thick);
          }
        } else {
          const minSide = em * 1.5;
          const maxLen = look.ruleStyle === 'accent' ? 0.08 * W : 0.24 * W;
          if (fit.lines.length === 1 && side >= minSide) {
            const len = Math.min(side, maxLen);
            const inner = textW / 2 + gap;
            const cy = lastBase - capH / 2;
            const half = look.divider === 'diamond' ? Math.max(thick, 0.18 * em * 0.75) : thick / 2;
            block.divider = { kind: look.divider, mode: 'side', em, len, inner, cy, thick, accent: look.ruleStyle === 'accent', boxes: [-1, 1].map((s) => sideBox(cx, s, inner, inner + len, cy - half, cy + half)) };
          } else {
            const len = Math.min(safeW * 0.22, look.ruleStyle === 'accent' ? 0.08 * W : safeW * 0.22);
            const cy = lastBase + capH * 1.6;
            const half = look.divider === 'diamond' ? Math.max(thick, 0.18 * em * 0.75) : thick / 2;
            block.divider = { kind: look.divider, mode: 'below', em, len, inner: 0, cy, thick, boxes: [{ x0: cx - len, x1: cx + len, y0: cy - half, y1: cy + half }] };
          }
        }
        if (block.divider.mode === 'below') {
          const bottom = Math.max(...block.divider.boxes.map((b) => b.y1));
          block.box.y1 = Math.max(block.box.y1, bottom);
        }
      }
      blocks.push(block);
    }
    // a flourish with no composer: one centred ornament between the main group and the footer
    if (flourish && !present.includes('composer') && blocks.some((b) => MAIN_ROLES.includes(b.role as TextRole))) {
      const lastMain = blocks.reduce((i, b, j) => (MAIN_ROLES.includes(b.role as TextRole) ? j : i), -1);
      const refPx = look.lines.composer.size * B * k;
      const half = Math.min(safeW * 0.36, fw * refPx * emMul);
      const div = belowFlourish(cx, 0, half, flourish, look.divider, thick);
      const h = div.boxes[0].y1 - div.boxes[0].y0;
      const orn: BlockLayout = {
        role: 'ornament',
        lines: [],
        spec: null,
        font: '',
        digitsFont: null,
        px: refPx,
        track: 0,
        cap: 0,
        lineGap: 0,
        top: 0,
        baselines: [],
        lineWidths: [],
        textW: 0,
        box: { x0: cx - half, x1: cx + half, y0: 0, y1: h },
        divider: div,
      };
      blocks.splice(lastMain + 1, 0, orn);
    }

    // stack: block boxes start at y = 0 locally; place them with the gaps
    let y = 0;
    blocks.forEach((b, i) => {
      if (i) y += gapKey(blocks[i - 1].role, b.role) * B * k * gapMul;
      shiftBlock(b, y - b.box.y0);
      y = b.box.y1;
    });
    const content = unionRect(blocks.flatMap((b) => [b.box, ...(b.divider?.boxes ?? [])]));
    const total = content.y1 - content.y0;
    if (total > safeH && pass < 4) {
      k *= (safeH / total) * 0.99;
      continue;
    }
    // centre in the safe area, raised 1 % of H in landscape (optical centre), never outside it
    let dy = safe.y0 + (safeH - total) / 2 - content.y0 - (portrait ? 0 : 0.01 * H);
    dy = Math.max(dy, safe.y0 - content.y0);
    dy = Math.min(dy, safe.y1 - content.y1);
    for (const b of blocks) shiftBlock(b, dy);
    result = {
      W,
      H,
      B,
      k,
      portrait,
      safe,
      blocks,
      content: { x0: content.x0, x1: content.x1, y0: content.y0 + dy, y1: content.y1 + dy },
    };
    break;
  }
  return result!;
}

function sideBox(cx: number, s: number, near: number, far: number, y0: number, y1: number): Rect {
  // `near` / `far`: distances of the shape's inner and outer ends from the centre line
  const a = cx + s * near;
  const b = cx + s * far;
  return { x0: Math.min(a, b), x1: Math.max(a, b), y0, y1 };
}

function belowFlourish(cx: number, top: number, half: number, f: { minX: number; maxX: number; minY: number; maxY: number }, kind: DividerId, thick: number): DividerLayout {
  const fw = f.maxX - f.minX;
  const em = half / fw;
  const h = (f.maxY - f.minY) * em;
  const cy = top + h / 2;
  return { kind, mode: 'below', em, len: half, inner: 0, cy, thick, boxes: [{ x0: cx - half, x1: cx + half, y0: top, y1: top + h }] };
}

function shiftBlock(b: BlockLayout, dy: number) {
  b.top += dy;
  b.baselines = b.baselines.map((v) => v + dy);
  b.box = { ...b.box, y0: b.box.y0 + dy, y1: b.box.y1 + dy };
  if (b.divider) {
    b.divider.cy += dy;
    b.divider.boxes = b.divider.boxes.map((r) => ({ ...r, y0: r.y0 + dy, y1: r.y1 + dy }));
  }
}

export function unionRect(rs: Rect[]): Rect {
  return rs.reduce((a, r) => ({ x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1) }), {
    x0: Infinity,
    y0: Infinity,
    x1: -Infinity,
    y1: -Infinity,
  });
}

/** Canvas-backed measurer with a small cache (one per drawing context). */
export function canvasMeasurer(ctx: { font: string; measureText(s: string): TextMetrics }): Measurer {
  const wc = new Map<string, number>();
  const ec = new Map<string, { asc: number; desc: number }>();
  return {
    width(font, s) {
      const key = font + '\u0000' + s;
      let v = wc.get(key);
      if (v === undefined) {
        ctx.font = font;
        v = ctx.measureText(s).width;
        if (wc.size > 4000) wc.clear();
        wc.set(key, v);
      }
      return v;
    },
    extent(font, s) {
      const key = font + '\u0000' + s;
      let v = ec.get(key);
      if (!v) {
        ctx.font = font;
        const mt = ctx.measureText(s);
        v = { asc: mt.actualBoundingBoxAscent, desc: mt.actualBoundingBoxDescent };
        if (ec.size > 2000) ec.clear();
        ec.set(key, v);
      }
      return v;
    },
  };
}
