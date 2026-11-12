/**
 * Original procedural ornaments for the title page (no copied artwork): calligraphic strokes are
 * built by "turtle" integration of clothoid pieces (curvature changes linearly along each piece)
 * and filled as variable-width outlines with round ends. Units: 1 = 1 em of the composer line.
 * Only the left ornament is built; the right one is drawn mirrored.
 */
import { FLOURISH_BOUNDS, type FlourishId } from './flourishBounds';

const TAU = Math.PI * 2;
/** stroke width multiplier (overall weight of the ornaments) */
const WMUL = 1.45;

interface Seg {
  len: number;
  k0: number;
  k1: number;
  w0: number;
  w1: number;
  ease?: boolean;
}
interface Pt {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function turtle(x: number, y: number, h: number, segs: Seg[], step = 0.02): Pt[] {
  const pts: Pt[] = [{ x, y, w: segs[0].w0, h }];
  for (const s of segs) {
    const n = Math.max(2, Math.ceil(s.len / step));
    const ds = s.len / n;
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      h += (s.k0 + (s.k1 - s.k0) * u) * ds;
      x += Math.cos(h) * ds;
      y += Math.sin(h) * ds;
      pts.push({ x, y, w: s.w0 + (s.w1 - s.w0) * (s.ease ? u * u * (3 - 2 * u) : u), h });
    }
  }
  return pts;
}

/** Variable-width outline of a stroke through `pts`, with a round start and a ball terminal. */
export function strokeShape(p: Path2D, pts: Pt[], ball = 0): void {
  const L: [number, number][] = [];
  const R: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const d = Math.hypot(nx, ny) || 1;
    nx /= d;
    ny /= d;
    const w = (pts[i].w / 2) * WMUL;
    L.push([pts[i].x + nx * w, pts[i].y + ny * w]);
    R.push([pts[i].x - nx * w, pts[i].y - ny * w]);
  }
  p.moveTo(L[0][0], L[0][1]);
  for (const q of L) p.lineTo(q[0], q[1]);
  for (let i = R.length - 1; i >= 0; i--) p.lineTo(R[i][0], R[i][1]);
  p.closePath();
  const s = pts[0];
  p.moveTo(s.x + (s.w * WMUL) / 2, s.y);
  p.arc(s.x, s.y, (s.w * WMUL) / 2, 0, TAU);
  const e = pts[pts.length - 1];
  const br = Math.max(ball * WMUL, (e.w * WMUL) / 2);
  p.moveTo(e.x + br, e.y);
  p.arc(e.x, e.y, br, 0, TAU);
}

export function leafShape(p: Path2D, x: number, y: number, a: number, len: number, wid: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const T = (u: number, v: number): [number, number] => [x + u * c - v * s, y + u * s + v * c];
  const p0 = T(0, 0);
  const q1 = T(len * 0.45, -wid);
  const p1 = T(len, 0);
  const q2 = T(len * 0.45, wid);
  p.moveTo(p0[0], p0[1]);
  p.quadraticCurveTo(q1[0], q1[1], p1[0], p1[1]);
  p.quadraticCurveTo(q2[0], q2[1], p0[0], p0[1]);
  p.closePath();
}

const at = (pts: Pt[], f: number) => pts[Math.min(pts.length - 1, Math.floor(f * (pts.length - 1)))];

/** Vine: a long stem curling into a spiral, a counter-curl, a small upper curl and four leaves. */
function vine(): Path2D {
  const p = new Path2D();
  const stem = turtle(0, 0, Math.PI, [
    { len: 0.9, k0: 0, k1: 0.25, w0: 0.012, w1: 0.04 },
    { len: 1.3, k0: 0.25, k1: -0.3, w0: 0.04, w1: 0.065, ease: true },
    { len: 0.7, k0: -0.3, k1: 0.6, w0: 0.065, w1: 0.06 },
    { len: 2.0, k0: 0.6, k1: 7.5, w0: 0.06, w1: 0.016 },
  ]);
  strokeShape(p, stem, 0.055);
  const b = at(stem, 0.5);
  strokeShape(
    p,
    turtle(b.x, b.y, b.h - 0.65, [
      { len: 0.35, k0: 0, k1: -0.8, w0: 0.035, w1: 0.04 },
      { len: 1.0, k0: -0.8, k1: -10, w0: 0.04, w1: 0.012 },
    ]),
    0.04,
  );
  const c = at(stem, 0.28);
  strokeShape(
    p,
    turtle(c.x, c.y, c.h + 0.75, [
      { len: 0.25, k0: 0, k1: 0.8, w0: 0.025, w1: 0.03 },
      { len: 0.65, k0: 0.8, k1: 13, w0: 0.03, w1: 0.01 },
    ]),
    0.03,
  );
  const leaf = (f: number, side: number, len: number, wid: number) => {
    const q = at(stem, f);
    leafShape(p, q.x, q.y, q.h + side * 0.75, len, wid);
  };
  leaf(0.16, -1, 0.42, 0.11);
  leaf(0.38, 1, 0.5, 0.13);
  leaf(0.44, -1, 0.36, 0.1);
  leaf(0.62, -1, 0.3, 0.08);
  p.moveTo(0.145, 0);
  p.arc(0.1, 0, 0.045, 0, TAU);
  return p;
}

/** Lyre scroll: a hairline with a lozenge, two mirrored curls at the outer end and a teardrop. */
function scroll(): Path2D {
  const p = new Path2D();
  const L = 3.0;
  strokeShape(p, turtle(0, 0, Math.PI, [{ len: L, k0: 0, k1: 0, w0: 0.012, w1: 0.03 }]));
  p.moveTo(-0.25, 0);
  p.lineTo(-0.42, -0.07);
  p.lineTo(-0.59, 0);
  p.lineTo(-0.42, 0.07);
  p.closePath();
  for (const s of [-1, 1]) {
    strokeShape(
      p,
      turtle(-L, 0, Math.PI, [
        { len: 0.3, k0: 0, k1: s * 0.8, w0: 0.03, w1: 0.06 },
        { len: 1.5, k0: s * 0.8, k1: s * 10, w0: 0.06, w1: 0.014 },
      ]),
      0.05,
    );
    strokeShape(p, turtle(-L * 0.55, 0, Math.PI + s * 0.5, [{ len: 0.7, k0: -s * 0.5, k1: -s * 12, w0: 0.022, w1: 0.008 }]), 0.026);
  }
  p.moveTo(-L - 0.12, 0);
  p.bezierCurveTo(-L - 0.25, -0.1, -L - 0.42, -0.06, -L - 0.45, 0);
  p.bezierCurveTo(-L - 0.42, 0.06, -L - 0.25, 0.1, -L - 0.12, 0);
  return p;
}

const cache = new Map<FlourishId, Path2D>();

/** Cached left ornament path (inner end at the origin, extending to negative x). */
export function getFlourishPath(id: FlourishId): Path2D {
  let p = cache.get(id);
  if (!p) {
    p = id === 'vine' ? vine() : scroll();
    cache.set(id, p);
  }
  return p;
}

export { FLOURISH_BOUNDS };
