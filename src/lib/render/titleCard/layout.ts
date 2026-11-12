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

/** the other lines' capitals at most this much of the title's (hierarchy with long titles) */
const CAP_LIMIT: Record<TextRole, number> = { title: 1, subtitle: 0.62, composer: 0.75, credit: 0.6, small: 0.45 };
/** the credit and small line at most this much of the title's width (but always half the safe width) */
const FOOTER_WIDTH = 0.7;

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
 * or as one string when the tracking is negligible. `wordSpace` (em) is added at every space.
 */
export function trackedWidth(m: Measurer, font: string, digitsFont: string | null, s: string, px: number, track: number, wordSpace = 0): number {
  const extra = wordSpace ? wordSpace * px * (s.match(/ /g)?.length ?? 0) : 0;
  if (track < TRACK_WHOLE) return m.width(font, s) + extra;
  const gs = splitGraphemes(s);
  let w = 0;
  for (const g of gs) w += m.width(digitsFont && isDigit(g) ? digitsFont : font, g);
  return w + track * px * Math.max(0, gs.length - 1) + extra;
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

export interface FitOptions {
  maxLines: number;
  /** wrap onto more lines while the letters would shrink below this (of the design size) */
  accept: number;
  /** a single line is kept down to this size (short titles in landscape stay on one line) */
  oneLine?: number;
  /** the letter spacing may tighten down to this fraction before the letters shrink */
  trackFloor?: number;
}

/** Below this size a single Latin word is split (with a hyphen) as a last resort. */
const WORD_SPLIT_BELOW = 0.42;

/**
 * Chooses line breaks, tracking and size so the text fits `maxW`. Latin words are never broken
 * between letters (a long word is tightened and shrunk instead; only an extremely long one is
 * hyphenated). Caseless scripts (CJK) break at the user's spaces first, then between characters.
 */
export function fitLine(m: Measurer, spec: LineSpec, str: string, px0: number, maxW: number, o: FitOptions): FitResult {
  const digitsAt = (px: number) => (spec.digits ? fontCss({ font: spec.digits, weight: spec.weight }, px) : null);
  const width = (s: string, px: number, track: number) => trackedWidth(m, fontCss(spec, px), digitsAt(px), s, px, track, spec.wordSpace);
  const floor = o.trackFloor ?? 0.6;

  /** tighten the letter spacing first, then shrink, until the widest line fits */
  const settle = (lines: string[]): FitResult & { eff: number } => {
    const widest0 = Math.max(...lines.map((x) => width(x, px0, spec.track)));
    const scale = Math.min(1, maxW / Math.max(1e-6, widest0));
    let px = px0;
    let track = spec.track;
    if (scale < 1) {
      track = Math.max(spec.track * floor, spec.track * scale);
      for (let pass = 0; pass < 5; pass++) {
        const widest = Math.max(...lines.map((x) => width(x, px, track)));
        if (widest <= maxW) break;
        px *= (maxW / widest) * (pass ? 0.995 : 1);
      }
    }
    return { lines, px, track, eff: px / px0 };
  };

  const trackPx = spec.track >= TRACK_WHOLE ? spec.track * px0 : 0;
  /** balanced breaks of `tokens` into 2..maxLines lines; keeps the best that beats `best` clearly */
  const tryBreaks = (best: ReturnType<typeof settle>, tokens: string[], joinStr: string, hyphen = false) => {
    const tokW = tokens.map((t) => width(t, px0, spec.track) + trackPx);
    const joiner = joinStr ? m.width(fontCss(spec, px0), ' ') + trackPx + (spec.wordSpace ?? 0) * px0 : 0;
    const hy = hyphen ? width('-', px0, spec.track) + trackPx : 0;
    const limit = Math.min(o.maxLines, tokens.length);
    for (let n = 2; n <= limit; n++) {
      const starts = balancedBreaks(tokW, n, joiner, hy - trackPx);
      const l = starts.map((st, i) => tokens.slice(st, starts[i + 1] ?? tokens.length).join(joinStr).trim()).filter(Boolean);
      const lines = hyphen ? l.map((x, i) => (i < l.length - 1 ? x + '-' : x)) : l;
      const r = settle(lines);
      if (r.eff > best.eff + 0.04) best = r;
      if (r.eff >= o.accept) break;
    }
    return best;
  };

  const words = str.split(/\s+/).filter(Boolean);
  const caseless = CASELESS.test(str);
  let best = settle([str]);
  if (best.eff >= (o.oneLine ?? o.accept)) return best;
  if (words.length > 1) best = tryBreaks(best, words, ' ');
  // the user's spaces win unless breaking there leaves the letters much too small
  if (caseless && best.eff < (words.length > 1 ? Math.min(o.accept, 0.72) : o.accept)) {
    // a caseless word longer than a line: between characters (the spaces were tried first)
    const tokens = splitGraphemes(str.replace(/\s+/g, ' '));
    best = tryBreaks(best, tokens, '');
  } else if (best.eff < WORD_SPLIT_BELOW && words.length === 1 && splitGraphemes(str).length >= 12) {
    best = tryBreaks(best, splitGraphemes(str), '', true);
  }
  return best;
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
  const footerGapMul = portrait ? 1.1 : 1;
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
      let px0 = spec.size * B * k * (opts.sizeMul?.[role] ?? 1);
      const titleBlock = blocks.find((b) => b.role === 'title');
      // hierarchy: no line outgrows the title's capitals
      if (titleBlock && role !== 'title') {
        const capRatio = (spec.upper ? m.extent(fontCss(spec, px0), 'H').asc || px0 * 0.7 : px0 * 0.75) / px0;
        const maxCap = titleBlock.cap * CAP_LIMIT[role];
        px0 = Math.min(px0, maxCap / Math.max(1e-6, capRatio));
      }
      const words = str.split(' ').length;
      const fitOpts: FitOptions =
        role === 'title'
          ? { maxLines: portrait ? 4 : 3, accept: portrait ? 0.95 : 0.82, oneLine: !portrait && words <= 4 ? 0.66 : undefined }
          : { maxLines: 2, accept: role === 'composer' ? 0.58 : 0.62, trackFloor: role === 'credit' || role === 'small' ? 0.4 : 0.6 };
      // the credit and the small line stay clearly narrower than the title
      const maxW = (role === 'credit' || role === 'small') && titleBlock ? Math.min(safeW, Math.max(FOOTER_WIDTH * titleBlock.textW, 0.5 * safeW)) : safeW;
      const fit = fitLine(m, spec, str, px0, maxW, fitOpts);
      const font = fontCss(spec, fit.px);
      const digitsFont = spec.digits ? fontCss({ font: spec.digits, weight: spec.weight }, fit.px) : null;
      const lineWidths = fit.lines.map((l) => trackedWidth(m, font, digitsFont, l, fit.px, fit.track, spec.wordSpace));
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
            block.divider = belowFlourish(cx, lastBase + capH * 1.05, Math.min(safeW * 0.36, natural), flourish, look.divider, thick);
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
      // in portrait the main group breathes more; the footer stays closer to it
      const footer = b.role === 'credit' || b.role === 'small';
      if (i) y += gapKey(blocks[i - 1].role, b.role) * B * k * (footer ? footerGapMul : gapMul);
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

/** gap (em) between the inner ends of a centred flourish pair */
export const BELOW_GAP = 0.12;

function belowFlourish(cx: number, top: number, half: number, f: { minX: number; maxX: number; minY: number; maxY: number }, kind: DividerId, thick: number): DividerLayout {
  const fw = f.maxX - f.minX;
  const em = half / (fw + BELOW_GAP);
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
