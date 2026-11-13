/**
 * Hands video geometry (pure, unit-tested): which real keys the camera shows, how the straightened
 * keyboard is placed in the exported frame, and the lanes the falling notes use so they land on the
 * real keys.
 *
 * Coordinates:
 *  - (u, v): the straightened keyboard. u runs 0..1 along the keys from the corners' left edge to the
 *    right edge (low to high); v = 0 at the back edge (where notes land by default) and v = 1 at the
 *    front edge of the white keys; v > 1 is the hands area in front of the keys.
 *  - the camera frame, normalized 0..1 (as shown: after the file's rotation and the user's turn/mirror);
 *    the four corners map the unit square onto it (a homography).
 *  - the output frame in pixels: x(u) = x0 + (u − ua)·s, y(v) = yTop + (v − hitV)·kh.
 */
import { BLACK_OFFSET, type KeyboardLayout, type KeyGeom } from '../render/layout';
import { isBlack, noteName, PIANO_MAX, PIANO_MIN } from '../music/theory';
import { UNIT_SQUARE, affine, chain, displayToCoded, homography, invert3, orientedToDisplay, type Mat3, type Pt } from '../geom/homography';
import type { Corner, HandVideo, HandVideoSync, KeyboardCalibration } from './types';

/** a standard piano key: 23.5 mm wide (white), 150 mm long */
export const WHITE_KEY_MM = 23.5;
export const KEY_LENGTH_MM = 150;

export interface KeyPreset {
  id: '88' | '76' | '61';
  label: string;
  lo: number;
  hi: number;
}
export const KEY_PRESETS: KeyPreset[] = [
  { id: '88', label: '88 keys (A0–C8)', lo: 21, hi: 108 },
  { id: '76', label: '76 keys (E1–G7)', lo: 28, hi: 103 },
  { id: '61', label: '61 keys (C2–C7)', lo: 36, hi: 96 },
];

export const presetFor = (lo: number, hi: number): KeyPreset['id'] | 'other' => KEY_PRESETS.find((p) => p.lo === lo && p.hi === hi)?.id ?? 'other';

/** Corners shown before any detection: a band across the middle of the frame. */
export const DEFAULT_CORNERS: [number, number][] = [
  [0.05, 0.38],
  [0.95, 0.38],
  [0.95, 0.62],
  [0.05, 0.62],
];

export const HIT_V_RANGE: [number, number] = [-0.3, 0.5];
export const HANDS_RANGE: [number, number] = [0.3, 2.5];
export const KEY_LENGTH_RANGE: [number, number] = [0.6, 1.6];
export const EDGE_RANGE = 1.5;

export function defaultCalibration(patch: Partial<KeyboardCalibration> = {}): KeyboardCalibration {
  return {
    v: 1,
    frameTime: 0,
    turn: 0,
    mirror: false,
    corners: DEFAULT_CORNERS.map((c) => [c[0], c[1]] as [number, number]),
    lo: 21,
    hi: 108,
    edgeL: 0,
    edgeR: 0,
    keyLength: 1,
    hitV: 0,
    hands: 1.1,
    view: 'all',
    ...patch,
  };
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** A calibration read from storage, with every field checked (older or damaged data never breaks an export). */
/** how far the edges can be moved (white keys): the Match slider plus half the Key width slider */
export const edgeLimit = (lo: number, hi: number): number => EDGE_RANGE + 0.015 * whitesBetween(lo, hi) + 1e-9;

export function sanitizeCalibration(c: unknown): KeyboardCalibration | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const r = c as Partial<KeyboardCalibration>;
  const d = defaultCalibration();
  const corners =
    Array.isArray(r.corners) && r.corners.length === 4 && r.corners.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => Number.isFinite(x)))
      ? r.corners.map((p) => [clamp(p[0], -0.5, 1.5), clamp(p[1], -0.5, 1.5)] as [number, number])
      : d.corners;
  let lo = Math.round(num(r.lo, d.lo));
  let hi = Math.round(num(r.hi, d.hi));
  lo = clamp(isBlack(lo) ? lo - 1 : lo, PIANO_MIN, PIANO_MAX);
  hi = clamp(isBlack(hi) ? hi + 1 : hi, PIANO_MIN, PIANO_MAX);
  if (hi - lo < 11) {
    lo = d.lo;
    hi = d.hi;
  }
  return {
    v: 1,
    frameTime: Math.max(0, num(r.frameTime, 0)),
    turn: r.turn === 180 ? 180 : 0,
    mirror: r.mirror === true,
    corners,
    lo,
    hi,
    // the Match slider (±EDGE_RANGE) plus half the Key width slider (±3% of the keys)
    edgeL: clamp(num(r.edgeL, 0), -edgeLimit(lo, hi), edgeLimit(lo, hi)),
    edgeR: clamp(num(r.edgeR, 0), -edgeLimit(lo, hi), edgeLimit(lo, hi)),
    keyLength: clamp(num(r.keyLength, 1), ...KEY_LENGTH_RANGE),
    hitV: clamp(num(r.hitV, 0), ...HIT_V_RANGE),
    hands: clamp(num(r.hands, d.hands), ...HANDS_RANGE),
    view: r.view === 'song' ? 'song' : 'all',
  };
}

/** Number of white keys from lo to hi (both included). */
export function whitesBetween(lo: number, hi: number): number {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) n++;
  return n;
}

/** 0-based white-key index of `midi` counted from `lo` (a black key counts as the white key below it). */
export function whiteIndex(lo: number, midi: number): number {
  let n = -1;
  for (let m = lo; m <= midi; m++) if (!isBlack(m)) n++;
  return n;
}

/** The fine-matched span in white-key units: white key i covers u in [(i − a)/(b − a), (i + 1 − a)/(b − a)]. */
export function whiteSpan(cal: Pick<KeyboardCalibration, 'lo' | 'hi' | 'edgeL' | 'edgeR'>): { a: number; b: number; n: number } {
  const n = whitesBetween(cal.lo, cal.hi);
  return { a: cal.edgeL, b: n + cal.edgeR, n };
}

/** u of the left edge of white key i (fractional i allowed). */
export function uOfWhite(cal: Pick<KeyboardCalibration, 'lo' | 'hi' | 'edgeL' | 'edgeR'>, i: number): number {
  const { a, b } = whiteSpan(cal);
  return (i - a) / (b - a);
}

/** Width ÷ length of the straightened keyboard (u span ÷ v span), from standard key sizes. */
export function keyboardAspect(cal: Pick<KeyboardCalibration, 'lo' | 'hi' | 'edgeL' | 'edgeR' | 'keyLength'>): number {
  const { a, b } = whiteSpan(cal);
  return ((b - a) * WHITE_KEY_MM) / (KEY_LENGTH_MM * cal.keyLength);
}

/** The part of the keyboard (in u) the video shows. */
export function viewWindow(cal: KeyboardCalibration, song?: { lo: number; hi: number } | null): [number, number] {
  if (cal.view !== 'song' || !song) return [0, 1];
  const lo = Math.max(cal.lo, Math.min(song.lo, cal.hi));
  const hi = Math.min(cal.hi, Math.max(song.hi, cal.lo));
  const i0 = whiteIndex(cal.lo, lo) - 2;
  const i1 = whiteIndex(cal.lo, hi) + 1 + 2;
  const ua = clamp(uOfWhite(cal, i0), 0, 1);
  const ub = clamp(uOfWhite(cal, i1), 0, 1);
  return ub - ua > 0.05 ? [ua, ub] : [0, 1];
}

export interface HandsGeometry {
  W: number;
  H: number;
  /** visible u window */
  ua: number;
  ub: number;
  /** px per unit of u */
  s: number;
  /** key length in px */
  kh: number;
  /** x of u = ua */
  x0: number;
  /** y of the hit line (v = hitV): the top of the video band */
  yTop: number;
  /** height of the video band (v from hitV to 1 + hands) */
  bandH: number;
  /** keyboard width shown */
  Kw: number;
  /** reserved for the watermark under the band */
  wmBand: number;
  hitV: number;
}

/** Smallest share of the frame height left for the falling notes. */
export const MIN_ROLL = { landscape: 0.4, portrait: 0.45 };

/**
 * Where the straightened keyboard goes in a W × H output ("Hands at the bottom"): as wide as the frame
 * (a small margin in portrait and square), the hands band at the bottom above the watermark, leaving at
 * least MIN_ROLL of the height for the notes (a wide keyboard in a tall frame is shrunk and centered).
 */
export function outputGeometry(W: number, H: number, cal: KeyboardCalibration, opts: { wmBand?: number; song?: { lo: number; hi: number } | null } = {}): HandsGeometry {
  const wmBand = Math.max(0, opts.wmBand ?? 0);
  const [ua, ub] = viewWindow(cal, opts.song);
  const A = keyboardAspect(cal);
  const landscape = W > H * 1.05;
  const m0 = landscape ? 0 : 0.02;
  const minRoll = W >= H ? MIN_ROLL.landscape : MIN_ROLL.portrait;
  const vSpan = 1 + cal.hands - cal.hitV;
  let s = (W * (1 - 2 * m0)) / (ub - ua);
  let kh = s / A;
  let bandH = vSpan * kh;
  let yTop = H - wmBand - bandH;
  if (yTop < minRoll * H) {
    s = ((H * (1 - minRoll) - wmBand) * A) / vSpan;
    kh = s / A;
    bandH = vSpan * kh;
    yTop = H - wmBand - bandH;
  }
  const Kw = s * (ub - ua);
  return { W, H, ua, ub, s, kh, x0: (W - Kw) / 2, yTop, bandH, Kw, wmBand, hitV: cal.hitV };
}

/** (u, v) → output px */
export function uvToOutput(g: HandsGeometry): Mat3 {
  return affine(g.s, g.kh, g.x0 - g.ua * g.s, g.yTop - g.hitV * g.kh);
}

/**
 * Lanes for the falling notes: a normal KeyboardLayout whose keys sit exactly over the camera's
 * keys (same black-key offsets as the Studio keyboard, lib/render/layout.ts).
 */
export function calibratedLayout(cal: KeyboardCalibration, g: Pick<HandsGeometry, 'x0' | 's' | 'ua' | 'W'>): KeyboardLayout {
  const { a, b } = whiteSpan(cal);
  const whiteW = g.s / (b - a);
  const blackW = whiteW * 0.6;
  const left = g.x0 - g.ua * g.s - a * whiteW; // x of white index 0's left edge at a = 0
  const keys: (KeyGeom | null)[] = new Array(128).fill(null);
  let wi = 0;
  for (let m = cal.lo; m <= cal.hi; m++) {
    if (!isBlack(m)) {
      keys[m] = { x: left + wi * whiteW, w: whiteW, black: false };
      wi++;
    } else {
      const boundary = left + wi * whiteW;
      keys[m] = { x: boundary - blackW / 2 + (BLACK_OFFSET[m % 12] ?? 0) * blackW, w: blackW, black: true };
    }
  }
  return { lo: cal.lo, hi: cal.hi, keys, whiteW, blackW, width: g.W };
}

/** Unit square → camera frame (normalized, as the user sees it). */
export const cornerHomography = (corners: [number, number][]): Mat3 => homography(UNIT_SQUARE, corners);

/**
 * Output px → texture coordinates (0..1) of a frame whose pixels are stored turned by `rotation`
 * (a decoded VideoFrame: the file's rotation; an already-rotated canvas: 0). `bandTop` is the output
 * y of the canvas row 0 the matrix is evaluated for (the warp canvas covers only the band).
 */
export function frameMatrix(cal: KeyboardCalibration, g: HandsGeometry, rotation: number, bandTop = g.yTop): Mat3 {
  return chain(displayToCoded(rotation), orientedToDisplay(cal.turn, cal.mirror), cornerHomography(cal.corners), invert3(uvToOutput(g)), affine(1, 1, 0, bandTop));
}

/** Output px (of a rect of rw × rh at its own origin) → the uv window [ua,ub] × [v0,v1] → texture coordinates. */
export function windowMatrix(cal: KeyboardCalibration, rw: number, rh: number, win: { ua: number; ub: number; v0: number; v1: number }, rotation: number): Mat3 {
  const toUv = affine((win.ub - win.ua) / rw, (win.v1 - win.v0) / rh, win.ua, win.v0);
  return chain(displayToCoded(rotation), orientedToDisplay(cal.turn, cal.mirror), cornerHomography(cal.corners), toUv);
}

/** Output px of an rw × rh rect → texture coordinates of the whole frame shown with "cover" (no calibration). */
export function coverMatrix(rw: number, rh: number, dw: number, dh: number, rotation: number): Mat3 {
  const scale = Math.max(rw / dw, rh / dh);
  const sx = rw / scale / dw;
  const sy = rh / scale / dh;
  return chain(displayToCoded(rotation), affine(sx / rw, sy / rh, (1 - sx) / 2, (1 - sy) / 2));
}

/** Aspect (width ÷ height) of the straightened keyboard plus hands area, for picture-in-picture. */
export function windowAspect(cal: KeyboardCalibration): number {
  return keyboardAspect(cal) / (1 + cal.hands - cal.hitV);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Picture-in-picture rectangle: `size` of the frame width, in a corner, clear of a bottom reserve. */
export function pipRect(W: number, H: number, corner: Corner, size: number, aspect: number, bottomReserve = 0): Rect {
  const margin = Math.round(0.03 * Math.min(W, H));
  let w = Math.round(clamp(size, 0.15, 0.6) * W);
  let h = Math.round(w / Math.max(0.2, aspect));
  const maxH = Math.round(H * 0.5);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * aspect);
  }
  const x = corner === 'tl' || corner === 'bl' ? margin : W - margin - w;
  const y = corner === 'tl' || corner === 'tr' ? margin : H - margin - h - bottomReserve;
  return { x, y, w, h };
}

/** Song notes the camera's keys don't cover (they are not shown in a hands video). */
export function notesOutside(cal: Pick<KeyboardCalibration, 'lo' | 'hi'>, notes: { midi: number }[]): number {
  let n = 0;
  for (const x of notes) if (x.midi < cal.lo || x.midi > cal.hi) n++;
  return n;
}

/** Lowest and highest note of a song (for the "just the keys in this song" view). */
export function noteSpan(notes: { midi: number }[]): { lo: number; hi: number } | null {
  if (!notes.length) return null;
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
  }
  return { lo, hi };
}

export const keyRangeLabel = (lo: number, hi: number): string => {
  const p = KEY_PRESETS.find((k) => k.lo === lo && k.hi === hi);
  return p ? p.label : `${whitesBetween(lo, hi) + countBlack(lo, hi)} keys (${noteName(lo)}–${noteName(hi)})`;
};

function countBlack(lo: number, hi: number): number {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (isBlack(m)) n++;
  return n;
}

/** White keys only (for the "leftmost / rightmost key" pickers). */
export function whiteKeys(from = PIANO_MIN, to = PIANO_MAX): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m++) if (!isBlack(m)) out.push(m);
  return out;
}

/** The corners make a sensible keyboard: convex, not tiny, ordered clockwise. */
export function cornersValid(c: Pt[] | [number, number][]): boolean {
  if (c.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i];
    const [x1, y1] = c[(i + 1) % 4];
    const [x2, y2] = c[(i + 2) % 4];
    const cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  const area = Math.abs(c.reduce((acc, p, i) => acc + p[0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * p[1], 0)) / 2;
  return sign > 0 && area > 0.002;
}

const SYNC_METHODS: HandVideoSync['method'][] = ['import', 'original', 'notes', 'manual'];

/**
 * A song's hands video as stored, checked: undefined when it can't be used (missing or damaged), with
 * a damaged calibration or sync dropped or repaired. Older or damaged data never breaks an export.
 */
export function sanitizeHandVideo(h: unknown): HandVideo | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const r = h as Partial<HandVideo>;
  if (r.store !== 'audio' && r.store !== 'handcam') return undefined;
  const w = num(r.displayW, 0);
  const ht = num(r.displayH, 0);
  if (w < 2 || ht < 2) return undefined;
  const s = r.sync as Partial<HandVideoSync> | undefined;
  const sync: HandVideoSync | undefined =
    s && typeof s === 'object' && SYNC_METHODS.includes(s.method as HandVideoSync['method']) && Number.isFinite(s.found)
      ? { method: s.method!, found: s.found!, confidence: num(s.confidence, 0), level: s.level === 'high' || s.level === 'medium' ? s.level : 'low', ...(s.drift ? { drift: true } : {}) }
      : undefined;
  const out: HandVideo = {
    v: 1,
    store: r.store,
    fileName: typeof r.fileName === 'string' ? r.fileName : 'video',
    mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
    size: Math.max(0, num(r.size, 0)),
    duration: Math.max(0, num(r.duration, 0)),
    displayW: Math.round(w),
    displayH: Math.round(ht),
    rotation: [0, 90, 180, 270].includes(r.rotation as number) ? (r.rotation as number) : 0,
    offset: clamp(num(r.offset, 0), -36000, 36000),
    addedAt: num(r.addedAt, 0),
  };
  if (Number.isFinite(r.fps) && (r.fps as number) > 0) out.fps = r.fps;
  if (typeof r.codec === 'string') out.codec = r.codec;
  if (sync) out.sync = sync;
  const cal = r.calibration ? sanitizeCalibration(r.calibration) : undefined;
  if (cal) out.calibration = cal;
  return out;
}
