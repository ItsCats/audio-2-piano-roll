// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * Noteheads, stems, bar lines, braces and brackets: ports of homr/note_detection.py,
 * homr/bar_line_detection.py and homr/brace_dot_detection.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { BoundingEllipse, type RotatedBoundingBox } from './boxes';
import { RotatedBoundingBox as RBB } from './boxes';
import { dilate, erode, img, rectKernel, structuringElement, type Img } from './cv';
import { boundingRect } from './geom';
import { median, MultiStaff, Note, pyRound, type Staff, type StemDirection } from './model';

const NOTEHEAD_SIZE_RATIO = 1.285714;

export interface NoteheadWithStem {
  notehead: BoundingEllipse;
  stem: RotatedBoundingBox | null;
  stemDirection: StemDirection | null;
}

/** homr combine_noteheads_with_stems */
export function combineNoteheadsWithStems(noteheads: BoundingEllipse[], stems: RotatedBoundingBox[]): NoteheadWithStem[] {
  const sorted = [...noteheads].sort((a, b) => a.box[0][1] - b.box[0][1]);
  const result: NoteheadWithStem[] = [];
  for (const n of sorted) {
    const thick = n.makeBoxThicker(15);
    let found = false;
    for (const stem of stems) {
      if (stem.isOverlapping(thick)) {
        result.push({ notehead: n, stem, stemDirection: stem.center[1] < n.center[1] ? 'up' : 'down' });
        found = true;
        break;
      }
    }
    if (!found) result.push({ notehead: n, stem: null, stemDirection: null });
  }
  return result;
}

type Rect4 = [number, number, number, number];

function adjustBbox(b: Rect4, noteheads: Img): Rect4 {
  let top = Infinity;
  let bottom = -Infinity;
  // numpy slicing clips to the image (and negative starts count from the end; boxes here are inside)
  const y0 = Math.max(0, b[1]);
  const y1 = Math.min(noteheads.h, b[3]);
  const x0 = Math.max(0, b[0]);
  const x1 = Math.min(noteheads.w, b[2]);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (noteheads.d[y * noteheads.w + x] > 0) {
        top = Math.min(top, y - y0);
        bottom = Math.max(bottom, y - y0);
      }
    }
  }
  if (top === Infinity) return b;
  return [b[0], top + b[1] - 1, b[2], bottom + b[1] + 1];
}

function getCenter(b: Rect4): [number, number] {
  return [pyRound((b[0] + b[2]) / 2), pyRound((b[1] + b[3]) / 2)];
}

function checkBboxSize(b: Rect4, noteheads: Img, unit: number): Rect4[] {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  const [cx] = getCenter(b);
  const noteW = NOTEHEAD_SIZE_RATIO * unit;
  let out: Rect4[] = [];
  if (Math.abs(w - noteW) > Math.abs(w - noteW * 2)) {
    const left = adjustBbox([b[0], b[1], cx, b[3]], noteheads);
    const right = adjustBbox([cx, b[1], b[2], b[3]], noteheads);
    out.push(...checkBboxSize(left, noteheads, unit));
    out.push(...checkBboxSize(right, noteheads, unit));
  }
  if (out.length) {
    const tmp: Rect4[] = [];
    for (const x of out) tmp.push(...checkBboxSize(x, noteheads, unit));
    out = tmp;
  } else {
    const num = pyRound(h / unit);
    if (num > 0) {
      const sub = Math.floor(h / num);
      for (let i = 0; i < num; i++) out.push([b[0], pyRound(b[1] + i * sub), b[2], pyRound(b[1] + (i + 1) * sub)]);
    }
  }
  return out;
}

function splitClumps(n: NoteheadWithStem, noteheads: Img, staff: Staff): NoteheadWithStem[] {
  const b: Rect4 = [Math.trunc(n.notehead.topLeft[0]), Math.trunc(n.notehead.topLeft[1]), Math.trunc(n.notehead.bottomRight[0]), Math.trunc(n.notehead.bottomRight[1])];
  const split = checkBboxSize(b, noteheads, staff.averageUnitSize);
  if (split.length <= 1) return [n];
  return split.map((s) => ({
    notehead: new BoundingEllipse([getCenter(s), [s[2] - s[0], s[3] - s[1]], 0], n.notehead.contours, n.notehead.debugId),
    stem: n.stem,
    stemDirection: n.stemDirection,
  }));
}

/** homr add_notes_to_staffs */
export function addNotesToStaffs(staffs: Staff[], noteheads: NoteheadWithStem[], noteheadMask: Img): Note[] {
  const result: Note[] = [];
  for (const staff of staffs) {
    for (const chunk of noteheads) {
      if (!staff.isOnStaffZone(chunk.notehead)) continue;
      const c = chunk.notehead.center;
      let p = staff.getAt(c[0]);
      if (!p) continue;
      if (chunk.notehead.size[0] < 0.5 * p.averageUnitSize || chunk.notehead.size[1] < 0.5 * p.averageUnitSize) continue;
      for (const n of splitClumps(chunk, noteheadMask, staff)) {
        p = staff.getAt(c[0]);
        if (!p) continue;
        const u = p.averageUnitSize;
        const [w, h] = n.notehead.size;
        if (w < 0.5 * u || w > 3 * u || h < 0.5 * u || h > 2 * u) continue;
        const note = new Note(n.notehead, p.findPositionInUnitSizes(n.notehead), n.stem, n.stemDirection);
        result.push(note);
        staff.symbols.push(note);
      }
    }
  }
  return result;
}

/** homr prepare_bar_line_image: dilate with a 3 x 5 rectangle */
export function prepareBarLineImage(stems: Img): Img {
  return dilate(stems, rectKernel(3, 5));
}

/** homr detect_bar_lines: keep the tall, thin candidates */
export function detectBarLines(barLines: RotatedBoundingBox[], unit: number): RotatedBoundingBox[] {
  return barLines.filter((b) => !(b.size[1] < 3 * unit) && !(b.size[0] > 2 * unit));
}

// ------------------------------------------------------------------ braces and brackets

/** homr prepare_brace_dot_image */
export function prepareBraceDotImage(symbols: Img, staff: Img): Img {
  const sub = img(symbols.w, symbols.h);
  for (let i = 0; i < sub.d.length; i++) sub.d[i] = Math.max(0, symbols.d[i] - staff.d[i]);
  return dilate(erode(sub, structuringElement('ellipse', 1, 5)), structuringElement('ellipse', 5, 35));
}

/** Rows of a filled contour polygon (cv2.drawContours FILLED) as row widths. */
function filledRowWidths(contour: Int32Array, x: number, y: number, w: number, h: number): Int32Array {
  // scanline fill with the outline included, like OpenCV's polygon fill of a traced border
  const mask = img(w, h);
  const n = contour.length / 2;
  const mark = (px: number, py: number) => {
    if (px >= 0 && py >= 0 && px < w && py < h) mask.d[py * w + px] = 1;
  };
  for (let k = 0; k < n; k++) {
    let x0 = contour[2 * k] - x;
    let y0 = contour[2 * k + 1] - y;
    const x1 = contour[2 * ((k + 1) % n)] - x;
    const y1 = contour[2 * ((k + 1) % n) + 1] - y;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      mark(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) (err += dy), (x0 += sx);
      if (e2 <= dx) (err += dx), (y0 += sy);
    }
  }
  // interior: even-odd crossings of the polygon edges at pixel centres
  for (let py = 0; py < h; py++) {
    const xs: number[] = [];
    for (let k = 0; k < n; k++) {
      const ax = contour[2 * k] - x;
      const ay = contour[2 * k + 1] - y;
      const bx = contour[2 * ((k + 1) % n)] - x;
      const by = contour[2 * ((k + 1) % n) + 1] - y;
      if (ay > py !== by > py) xs.push(ax + ((py - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let px = Math.ceil(xs[i]); px <= Math.floor(xs[i + 1]); px++) mark(px, py);
  }
  const widths = new Int32Array(h);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) widths[py] += mask.d[py * w + px];
  return widths;
}

function trimToCoreSpan(s: RotatedBoundingBox): RotatedBoundingBox {
  const [x, y, w, h] = boundingRect(s.contours);
  if (h <= 0 || w <= 0) return s;
  const widths = filledRowWidths(s.contours, x, y, w, h);
  let max = 0;
  for (const v of widths) max = Math.max(max, v);
  if (max === 0) return s;
  let lo = -1;
  let hi = -1;
  widths.forEach((v, i) => {
    if (v >= max * 0.5) {
      if (lo < 0) lo = i;
      hi = i;
    }
  });
  if (lo < 0) return s;
  const y0 = y + lo;
  const y1 = y + hi + 1;
  if (y1 - y0 <= 0) return s;
  return new RBB([[s.center[0], (y0 + y1) / 2], [s.size[0], y1 - y0], s.angle], s.contours, s.debugId);
}

function filterTallElements(braceDot: RotatedBoundingBox[], staffs: Staff[]): RotatedBoundingBox[] {
  const rough = staffs[0].averageUnitSize;
  const big = braceDot.filter((s) => s.size[1] > 2 * rough && s.size[0] < 3 * rough && s.size[0] >= 5);
  const out: RotatedBoundingBox[] = [];
  for (const s of big) {
    let best = staffs[0];
    let bd = best.yDistanceTo(s.center);
    for (const st of staffs) {
      const d = st.yDistanceTo(s.center);
      if (d < bd) (bd = d), (best = st);
    }
    if (s.size[1] > 4 * best.averageUnitSize) out.push(s);
  }
  return out;
}

function connectionsAtBarLines(a: Staff, b: Staff, bd: RotatedBoundingBox[]): RotatedBoundingBox[] {
  const l1 = a.getBarLines();
  const l2 = b.getBarLines();
  return bd.filter((s) => {
    const t = s.makeBoxThicker(30);
    return l1.some((l) => t.isOverlapping(l.box)) && l2.some((l) => t.isOverlapping(l.box));
  });
}

function connectionsAtClefs(a: Staff, b: Staff, bd: RotatedBoundingBox[]): RotatedBoundingBox[] {
  const c1 = a.getClefs();
  const c2 = b.getClefs();
  return bd.filter((s) => {
    const t = s.makeBoxThicker(0);
    return c1.some((c) => t.isOverlapping(c.box)) && c2.some((c) => t.isOverlapping(c.box));
  });
}

function connectionsAtLines(a: Staff, b: Staff, bd: RotatedBoundingBox[]): RotatedBoundingBox[] {
  const out: RotatedBoundingBox[] = [];
  for (const s of bd) {
    const t = s.makeBoxThicker(pyRound(a.averageUnitSize * 2));
    const p1 = a.getAt(s.center[0]);
    const p2 = b.getAt(s.center[0]);
    if (!p1 || !p2) continue;
    if (t.isOverlapping(p1.toBoundingBox()) && t.isOverlapping(p2.toBoundingBox())) out.push(s);
  }
  return out;
}

function mergeMultiStaffsSharingAStaff(staffs: MultiStaff[]): MultiStaff[] {
  const result: MultiStaff[] = [];
  for (const s of staffs) {
    let merged = false;
    for (const e of result) {
      if (s.staffs.some((x) => e.staffs.includes(x))) {
        result.splice(result.indexOf(e), 1);
        result.push(e.merge(s));
        merged = true;
        break;
      }
    }
    if (!merged) result.push(s);
  }
  return result;
}

/** homr find_braces_brackets_and_grand_staff_lines: staffs grouped into systems / grand staffs. */
export function findBracesBracketsAndGrandStaffLines(staffs: Staff[], braceDotIn: RotatedBoundingBox[]): MultiStaff[] {
  let braceDot = braceDotIn.map(trimToCoreSpan);
  braceDot = filterTallElements(braceDot, staffs);
  const result: MultiStaff[] = [];
  staffs.forEach((staff, i) => {
    const neighbors: Staff[] = [];
    if (i > 0) neighbors.push(staffs[i - 1]);
    if (i < staffs.length - 1) neighbors.push(staffs[i + 1]);
    let any = false;
    for (const nb of neighbors) {
      const conns = [...connectionsAtBarLines(staff, nb, braceDot), ...connectionsAtClefs(staff, nb, braceDot), ...connectionsAtLines(staff, nb, braceDot)];
      if (conns.length >= 1) {
        result.push(new MultiStaff([staff, nb], conns));
        any = true;
      }
    }
    if (!any) result.push(new MultiStaff([staff], []));
  });
  const merged = mergeMultiStaffsSharingAStaff(result);
  return merged.length ? merged.map((m) => m.createGrandstaffs(braceDot)) : merged;
}

export { median };
