/**
 * Staff and system finding (src/lib/omr): where are the five-line staves on a cleaned page
 * (page.ts preparePage), which of them form a piano grand staff, and the crop of each system that
 * the recognition model reads.
 *
 * Ported from the research prototype (projection of long horizontal ink runs, grouped into five
 * evenly spaced lines) with changes that matter for photos: the staff spacing is estimated from
 * vertical run lengths first, staves are found with a five-line comb that tolerates one faint line,
 * several vertical bands vote (a slightly curved or tilted page still lines up within a narrow band,
 * and a short last line is found too), and the two staves of a grand staff are paired by the line or
 * brace that joins them on the left.
 */
import { binarize, crop, horizontalRuns, padHeight, resize, type Gray } from './image';

export interface Staff {
  /** y of the five lines, top to bottom (page pixels) */
  lines: number[];
  top: number;
  bottom: number;
  /** distance between neighbouring lines */
  space: number;
  /** horizontal extent of the lines */
  x0: number;
  x1: number;
}

export interface SystemBox {
  /** indexes into the staff list */
  staves: number[];
  /** crop rectangle in page pixels */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** mean staff space of its staves */
  space: number;
  /** bar lines found across the whole system (system start line included), -1 when unknown */
  barlines: number;
}

/** Staff space (pixels between staff lines) the recognition model was trained on. */
export const MODEL_STAFF_SPACE = 9.8;
/** Smallest input height the model was trained on. */
export const MODEL_MIN_HEIGHT = 256;
/** Widest input the model accepts (its positional encoding was built for 3056 px). */
export const MODEL_MAX_WIDTH = 3000;

/** Most common vertical black-run (line thickness) and white-run (gap) lengths, from sampled columns. */
export function runLengths(ink: Uint8Array, w: number, h: number): { thickness: number; gap: number } {
  const black = new Uint32Array(64);
  const white = new Uint32Array(128);
  const step = Math.max(1, Math.floor(w / 200));
  for (let x = Math.floor(w * 0.05); x < w * 0.95; x += step) {
    let run = 0;
    let cur = ink[x];
    let seenBlack = false;
    for (let y = 0; y <= h; y++) {
      const v = y < h ? ink[y * w + x] : 2;
      if (v === cur) {
        run++;
        continue;
      }
      if (cur === 1) {
        if (run < 64) black[run]++;
        seenBlack = true;
      } else if (cur === 0 && seenBlack && v === 1 && run < 128) white[run]++;
      cur = v;
      run = 1;
    }
  }
  const mode = (hist: Uint32Array, from: number) => {
    let b = from;
    for (let i = from; i < hist.length; i++) if (hist[i] > hist[b]) b = i;
    return b;
  };
  return { thickness: Math.max(1, mode(black, 1)), gap: mode(white, 3) };
}

interface BandStaff {
  lines: number[];
  space: number;
  score: number;
}

/** Five-line comb over one band's row profile of long horizontal runs. */
function stavesInProfile(prof: Float32Array, space0: number): BandStaff[] {
  const n = prof.length;
  if (!(space0 >= 4)) return [];
  // local max over ±1 row tolerates lines that drift by a pixel
  const pm = new Float32Array(n);
  for (let y = 0; y < n; y++) pm[y] = Math.max(prof[y], y > 0 ? prof[y - 1] : 0, y < n - 1 ? prof[y + 1] : 0);
  const spaces: number[] = [];
  for (let s = space0 * 0.82; s <= space0 * 1.18; s += 0.25) spaces.push(s);
  const resp = new Float32Array(n);
  const respS = new Float32Array(n);
  const v = [0, 0, 0, 0, 0];
  for (let y = 0; y < n; y++) {
    for (const s of spaces) {
      if (y + 4 * s >= n - 1) break;
      for (let i = 0; i < 5; i++) v[i] = pm[Math.round(y + i * s)];
      // the second weakest line: one faint (or broken) line is forgiven
      const sorted = [...v].sort((a, b) => a - b);
      // empty rows between the lines (a staff is five lines, not a dark block)
      let between = 0;
      for (let i = 0; i < 4; i++) between = Math.max(between, prof[Math.round(y + (i + 0.5) * s)]);
      const r = sorted[1] + 0.5 * sorted[0] - 0.5 * between;
      if (r > resp[y]) {
        resp[y] = r;
        respS[y] = s;
      }
    }
  }
  let max = 0;
  for (let y = 0; y < n; y++) max = Math.max(max, resp[y]);
  if (max <= 0.08) return [];
  const thr = Math.max(0.08, 0.3 * max);
  const order = Array.from(resp.keys())
    .filter((y) => resp[y] > thr)
    .sort((a, b) => resp[b] - resp[a]);
  const taken: BandStaff[] = [];
  for (const y of order) {
    const s = respS[y];
    if (taken.some((t) => y < t.lines[4] + 1.5 * t.space && y + 4 * s > t.lines[0] - 1.5 * t.space)) continue;
    // refine each line to the profile's centroid nearby
    const lines: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = y + i * s;
      let sw = 0;
      let sy = 0;
      for (let yy = Math.max(0, Math.round(c - s / 3)); yy <= Math.min(n - 1, Math.round(c + s / 3)); yy++) {
        sw += prof[yy];
        sy += prof[yy] * yy;
      }
      lines.push(sw > 0 ? sy / sw : c);
    }
    taken.push({ lines, space: (lines[4] - lines[0]) / 4, score: resp[y] });
  }
  return taken.sort((a, b) => a.lines[0] - b.lines[0]);
}

/** Horizontal extent of the long runs near a staff's lines. */
function staffExtent(runs: Uint8Array, w: number, lines: number[]): [number, number] {
  let x0 = w;
  let x1 = 0;
  for (const ly of lines) {
    const y = Math.round(ly);
    // the longest run on this row (other runs: beams, text)
    let best = 0;
    let bx0 = 0;
    let bx1 = 0;
    for (const yy of [y - 1, y, y + 1]) {
      if (yy < 0 || yy * w >= runs.length) continue;
      let x = 0;
      while (x < w) {
        if (!runs[yy * w + x]) {
          x++;
          continue;
        }
        let e = x;
        // bridge small gaps (bar lines and note heads interrupt the run in binarized photos)
        while (e < w && (runs[yy * w + e] || (e + 6 < w && runs[yy * w + e + 6]))) e++;
        if (e - x > best) (best = e - x), (bx0 = x), (bx1 = e);
        x = e + 1;
      }
    }
    if (best) {
      x0 = Math.min(x0, bx0);
      x1 = Math.max(x1, bx1);
    }
  }
  return x0 < x1 ? [x0, x1] : [0, w];
}

/** Bands (fractions of the page width) that vote for staves. */
const BANDS: [number, number][] = [
  [0.1, 0.9],
  [0.04, 0.3],
  [0.26, 0.52],
  [0.48, 0.74],
  [0.7, 0.96],
];

export interface StaffFinding {
  staves: Staff[];
  /** estimated staff space of the page */
  space: number;
  ink: Uint8Array;
}

/** Ink threshold for staff finding (adaptive mean minus this; lower than the general 15 for faint photos). */
const STAFF_C = 6;
/** A pixel this much darker than the pixels a line-thickness above and below is part of a thin line. */
const LINE_CONTRAST = 12;

/** All five-line staves on a cleaned page, top to bottom. */
export function findStaves(page: Gray): StaffFinding {
  const { w, h } = page;
  const ink = binarize(page, 31, STAFF_C);
  const { thickness, gap } = runLengths(ink, w, h);
  const space0 = gap + thickness;
  const minRun = Math.max(8, Math.round(2.5 * space0));
  // thin dark horizontal lines: darker than the pixels a little above and below (faint lines in photos
  // survive this better than a threshold), or plain ink
  const r = Math.max(2, thickness + 1);
  const lm = new Uint8Array(w * h);
  const d = page.d;
  for (let y = r; y < h - r; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const c = d[o + x];
      lm[o + x] = ink[o + x] || (d[o + x - r * w] + d[o + x + r * w]) / 2 - c > LINE_CONTRAST ? 1 : 0;
    }
  }
  const runs = horizontalRuns(lm, w, h, minRun);
  const found: { band: number; st: BandStaff }[] = [];
  BANDS.forEach(([a, b], band) => {
    const xa = Math.floor(w * a);
    const xb = Math.floor(w * b);
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      const o = y * w;
      for (let x = xa; x < xb; x++) c += runs[o + x];
      prof[y] = c / (xb - xa);
    }
    for (const st of stavesInProfile(prof, space0)) found.push({ band, st });
  });
  // cluster the bands' staves by vertical overlap
  found.sort((p, q) => p.st.lines[2] - q.st.lines[2]);
  const clusters: { band: number; st: BandStaff }[][] = [];
  for (const f of found) {
    const last = clusters[clusters.length - 1];
    const c = last?.find((g) => Math.abs(g.st.lines[2] - f.st.lines[2]) < 2.5 * f.st.space);
    if (c && !last.some((g) => g.band === f.band)) last.push(f);
    else if (c) {
      // the same band twice in one cluster: keep the stronger
      const i = last.findIndex((g) => g.band === f.band);
      if (f.st.score > last[i].st.score) last[i] = f;
    } else clusters.push([f]);
  }
  const staves: Staff[] = [];
  for (const c of clusters) {
    const wide = c.some((g) => g.band === 0);
    if (!wide && c.length < 2) continue;
    // line positions: the wide band where it has them (straight pages), else the median of the bands
    const src = c.find((g) => g.band === 0)?.st;
    const lines = src ? src.lines : [0, 1, 2, 3, 4].map((i) => median(c.map((g) => g.st.lines[i])));
    const space = (lines[4] - lines[0]) / 4;
    // a tilted or curved page: the lines span more rows across the width
    const top = Math.min(...c.map((g) => g.st.lines[0]));
    const bottom = Math.max(...c.map((g) => g.st.lines[4]));
    const [x0, x1] = staffExtent(runs, w, lines);
    staves.push({ lines, top, bottom, space, x0, x1 });
  }
  // drop staves that overlap a stronger neighbour (e.g. a beam group mistaken for lines)
  const out: Staff[] = [];
  for (const s of staves) {
    const prev = out[out.length - 1];
    if (prev && s.top < prev.bottom + prev.space) continue;
    out.push(s);
  }
  return { staves: out, space: space0, ink };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Columns where ink runs (almost) unbroken from y0 to y1, merged into lines. Returns x centres. */
export function verticalLines(ink: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number, mergeWithin: number): number[] {
  const ya = Math.max(0, Math.round(y0));
  const yb = Math.round(y1);
  const need = 0.92 * (yb - ya + 1);
  const xs: number[] = [];
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
    let c = 0;
    for (let y = ya; y <= yb; y++) {
      // a pixel or its horizontal neighbours (slightly tilted lines)
      const o = y * w + x;
      if (ink[o] || (x > 0 && ink[o - 1]) || (x < w - 1 && ink[o + 1])) c++;
    }
    if (c >= need) xs.push(x);
  }
  const lines: number[] = [];
  let start = -1;
  let prev = -1;
  for (const x of xs) {
    if (start >= 0 && x - prev <= mergeWithin) {
      prev = x;
      continue;
    }
    if (start >= 0) lines.push((start + prev) / 2);
    start = prev = x;
  }
  if (start >= 0) lines.push((start + prev) / 2);
  return lines;
}

/** A brace (or any curve) left of the staves: almost every row between y0 and y1 has ink in [x0, x1). */
function braced(ink: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number): boolean {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(w, Math.ceil(x1));
  if (xb <= xa) return false;
  let rows = 0;
  let hit = 0;
  for (let y = Math.round(y0); y <= Math.round(y1); y++) {
    rows++;
    const o = y * w;
    for (let x = xa; x < xb; x++) {
      if (ink[o + x]) {
        hit++;
        break;
      }
    }
  }
  return rows > 0 && hit >= 0.97 * rows;
}

/**
 * Groups staves into systems. Two neighbouring staves form a grand staff when a line or brace joins
 * them at their left end; when no staff on the page is joined that way, staves are paired in order
 * (the prototype's rule, right for plain piano pages).
 */
export function groupSystems(page: Gray, finding: StaffFinding): SystemBox[] {
  const { staves, ink } = finding;
  if (!staves.length) return [];
  const w = page.w;
  const joined = staves.map((s, i) => {
    const t = staves[i + 1];
    if (!t) return false;
    const sp = (s.space + t.space) / 2;
    const xl = Math.min(s.x0, t.x0);
    return verticalLines(ink, w, xl - 4 * sp, xl + 2 * sp, s.lines[0] + 1, t.lines[4] - 1, 2).length > 0 || braced(ink, w, xl - 3.5 * sp, xl + 0.3 * sp, s.lines[0], t.lines[4]);
  });
  const anyJoined = joined.some(Boolean);
  const groups: number[][] = [];
  for (let i = 0; i < staves.length; i++) {
    if (i + 1 < staves.length && (anyJoined ? joined[i] : true)) {
      groups.push([i, i + 1]);
      i++;
    } else groups.push([i]);
  }
  const out: SystemBox[] = [];
  groups.forEach((g, k) => {
    const first = staves[g[0]];
    const last = staves[g[g.length - 1]];
    const sp = g.reduce((a, i) => a + staves[i].space, 0) / g.length;
    let y0 = first.top - 5 * sp;
    let y1 = last.bottom + 5 * sp;
    if (k > 0) y0 = Math.max(y0, (staves[groups[k - 1][groups[k - 1].length - 1]].bottom + first.top) / 2);
    else y0 = Math.max(0, y0);
    if (k + 1 < groups.length) y1 = Math.min(y1, (last.bottom + staves[groups[k + 1][0]].top) / 2);
    else y1 = Math.min(page.h, y1);
    const sx0 = Math.min(...g.map((i) => staves[i].x0));
    const sx1 = Math.max(...g.map((i) => staves[i].x1));
    const x0 = Math.max(0, sx0 - 2.5 * sp);
    const x1 = Math.min(w, sx1 + 1.5 * sp);
    const barlines = g.length === 2 ? verticalLines(ink, w, x0, x1, first.lines[0] + 1, last.lines[4] - 1, Math.max(2, Math.round(sp * 0.9))).length : -1;
    out.push({ staves: g, x0, y0: Math.floor(y0), x1, y1: Math.ceil(y1), space: sp, barlines });
  });
  return out;
}

/** The model's input for one system: cropped, scaled to the trained staff space, padded to 256 rows. */
export function systemImage(page: Gray, box: SystemBox): Gray {
  const c = crop(page, box.x0, box.y0, box.x1, box.y1);
  let r = MODEL_STAFF_SPACE / box.space;
  if (c.w * r > MODEL_MAX_WIDTH) r = MODEL_MAX_WIDTH / c.w;
  const scaled = resize(c, Math.max(32, c.w * r), Math.max(32, c.h * r));
  return padHeight(scaled, MODEL_MIN_HEIGHT);
}

/** Float input tensor data (0 = ink, 1 = paper), [1, 1, h, w] row-major. */
export function modelInput(img: Gray): Float32Array {
  const f = new Float32Array(img.d.length);
  for (let i = 0; i < f.length; i++) f[i] = img.d[i] / 255;
  return f;
}

/** Shrinks a gray image so its longer side is at most `max` pixels (photos straight from a phone). */
export function limitSize(img: Gray, max: number): Gray {
  const m = Math.max(img.w, img.h);
  if (m <= max) return img;
  const s = max / m;
  return resize(img, img.w * s, img.h * s);
}
