/**
 * OpenCV's Subdiv2D Delaunay triangulation (quad-edge structure, incremental insertion with edge flips,
 * getTriangleList), ported so that homr's dewarping mesh gets the same triangles in the same order as
 * in Python homr: homr's PiecewiseAffineTransform paints the triangles one after the other, and pixels
 * on a shared edge keep the colour of the later triangle, so the order matters for those pixels.
 *
 * Follows modules/imgproc/src/subdivision2d.cpp of OpenCV 4.x (Apache-2.0); coordinates are float32
 * (Point2f), the orientation tests double precision, as there. Used by staffImage.ts (homr
 * DelaunayTriangulation, derived from homr, AGPL-3.0, Copyright the homr contributors,
 * https://github.com/liebharc/homr).
 */
import type { Pt } from './geom';

const f = Math.fround;
const FLT_EPSILON = 1.1920928955078125e-7;

const PTLOC_ERROR = -2;
const PTLOC_INSIDE = 0;
const PTLOC_VERTEX = 1;
const PTLOC_ON_EDGE = 2;

const NEXT_AROUND_LEFT = 0x13;
const PREV_AROUND_ORG = 0x11;
const PREV_AROUND_DST = 0x33;
const PREV_AROUND_LEFT = 0x20;

interface QuadEdge {
  next: [number, number, number, number];
  pt: [number, number, number, number];
}
interface Vertex {
  firstEdge: number;
  /** -1 free, 0 real, 1 virtual */
  type: number;
  x: number;
  y: number;
}

const emptyEdge = (): QuadEdge => ({ next: [0, 0, 0, 0], pt: [0, 0, 0, 0] });
const quadEdge = (e: number): QuadEdge => ({ next: [e, e + 3, e + 2, e + 1], pt: [0, 0, 0, 0] });

function triangleArea(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export class Subdiv2D {
  private qedges: QuadEdge[] = [];
  private vtx: Vertex[] = [];
  private freeQEdge = 0;
  private freePoint = 0;
  private recentEdge = 0;
  private tlx = 0;
  private tly = 0;
  private brx = 0;
  private bry = 0;

  /** rect: x, y, width, height (integers, cv::Rect) */
  constructor(rect: [number, number, number, number]) {
    const [x, y, w, h] = rect;
    const big = f(6 * Math.max(w, h));
    const rx = f(x);
    const ry = f(y);
    this.tlx = rx;
    this.tly = ry;
    this.brx = f(rx + w);
    this.bry = f(ry + h);
    this.vtx.push({ firstEdge: 0, type: -1, x: 0, y: 0 });
    this.qedges.push(emptyEdge());
    const pA = this.newPoint(f(rx + big), ry, false);
    const pB = this.newPoint(rx, f(ry + big), false);
    const pC = this.newPoint(f(rx - big), f(ry - big), false);
    const eAB = this.newEdge();
    const eBC = this.newEdge();
    const eCA = this.newEdge();
    this.setEdgePoints(eAB, pA, pB);
    this.setEdgePoints(eBC, pB, pC);
    this.setEdgePoints(eCA, pC, pA);
    this.splice(eAB, eCA ^ 2);
    this.splice(eBC, eAB ^ 2);
    this.splice(eCA, eBC ^ 2);
    this.recentEdge = eAB;
  }

  private nextEdge(e: number): number {
    return this.qedges[e >> 2].next[e & 3];
  }
  private rotateEdge(e: number, r: number): number {
    return (e & ~3) + ((e + r) & 3);
  }
  private getEdge(e: number, type: number): number {
    const n = this.qedges[e >> 2].next[(e + type) & 3];
    return (n & ~3) + ((n + (type >> 4)) & 3);
  }
  private edgeOrg(e: number): number {
    return this.qedges[e >> 2].pt[e & 3];
  }
  private edgeDst(e: number): number {
    return this.qedges[e >> 2].pt[(e + 2) & 3];
  }

  private splice(a: number, b: number): void {
    const qa = this.qedges[a >> 2].next;
    const qb = this.qedges[b >> 2].next;
    const aNext = qa[a & 3];
    const bNext = qb[b & 3];
    const aRot = this.rotateEdge(aNext, 1);
    const bRot = this.rotateEdge(bNext, 1);
    qa[a & 3] = bNext;
    qb[b & 3] = aNext;
    const qar = this.qedges[aRot >> 2].next;
    const qbr = this.qedges[bRot >> 2].next;
    const t = qar[aRot & 3];
    qar[aRot & 3] = qbr[bRot & 3];
    qbr[bRot & 3] = t;
  }

  private setEdgePoints(e: number, org: number, dst: number): void {
    const q = this.qedges[e >> 2];
    q.pt[e & 3] = org;
    q.pt[(e + 2) & 3] = dst;
    this.vtx[org].firstEdge = e;
    this.vtx[dst].firstEdge = e ^ 2;
  }

  private connectEdges(a: number, b: number): number {
    const e = this.newEdge();
    this.splice(e, this.getEdge(a, NEXT_AROUND_LEFT));
    this.splice(e ^ 2, b);
    this.setEdgePoints(e, this.edgeDst(a), this.edgeOrg(b));
    return e;
  }

  private swapEdges(e: number): void {
    const s = e ^ 2;
    const a = this.getEdge(e, PREV_AROUND_ORG);
    const b = this.getEdge(s, PREV_AROUND_ORG);
    this.splice(e, a);
    this.splice(s, b);
    this.setEdgePoints(e, this.edgeDst(a), this.edgeDst(b));
    this.splice(e, this.getEdge(a, NEXT_AROUND_LEFT));
    this.splice(s, this.getEdge(b, NEXT_AROUND_LEFT));
  }

  private isRightOf(x: number, y: number, e: number): number {
    const o = this.vtx[this.edgeOrg(e)];
    const d = this.vtx[this.edgeDst(e)];
    const a = triangleArea(x, y, d.x, d.y, o.x, o.y);
    return (a > 0 ? 1 : 0) - (a < 0 ? 1 : 0);
  }

  private newEdge(): number {
    if (this.freeQEdge <= 0) {
      this.qedges.push(emptyEdge());
      this.freeQEdge = this.qedges.length - 1;
    }
    const e = this.freeQEdge * 4;
    this.freeQEdge = this.qedges[e >> 2].next[1];
    this.qedges[e >> 2] = quadEdge(e);
    return e;
  }

  private deleteEdge(e: number): void {
    this.splice(e, this.getEdge(e, PREV_AROUND_ORG));
    const s = e ^ 2;
    this.splice(s, this.getEdge(s, PREV_AROUND_ORG));
    const q = this.qedges[e >> 2];
    q.next[0] = 0;
    q.next[1] = this.freeQEdge;
    this.freeQEdge = e >> 2;
  }

  private newPoint(x: number, y: number, isVirtual: boolean, firstEdge = 0): number {
    if (this.freePoint === 0) {
      this.vtx.push({ firstEdge: 0, type: -1, x: 0, y: 0 });
      this.freePoint = this.vtx.length - 1;
    }
    const v = this.freePoint;
    this.freePoint = this.vtx[v].firstEdge;
    this.vtx[v] = { firstEdge, type: isVirtual ? 1 : 0, x, y };
    return v;
  }

  private locate(x: number, y: number): { loc: number; edge: number; vertex: number } {
    const maxEdges = this.qedges.length * 4;
    if (x < this.tlx || y < this.tly || x >= this.brx || y >= this.bry) throw new Error('Subdiv2D: point outside the rectangle');
    let edge = this.recentEdge;
    let vertex = 0;
    let loc = PTLOC_ERROR;
    let rightOfCurr = this.isRightOf(x, y, edge);
    if (rightOfCurr > 0) {
      edge ^= 2;
      rightOfCurr = -rightOfCurr;
    }
    for (let i = 0; i < maxEdges; i++) {
      const onext = this.nextEdge(edge);
      const dprev = this.getEdge(edge, PREV_AROUND_DST);
      const rightOfOnext = this.isRightOf(x, y, onext);
      const rightOfDprev = this.isRightOf(x, y, dprev);
      if (rightOfDprev > 0) {
        if (rightOfOnext > 0 || (rightOfOnext === 0 && rightOfCurr === 0)) {
          loc = PTLOC_INSIDE;
          break;
        }
        rightOfCurr = rightOfOnext;
        edge = onext;
      } else if (rightOfOnext > 0) {
        if (rightOfDprev === 0 && rightOfCurr === 0) {
          loc = PTLOC_INSIDE;
          break;
        }
        rightOfCurr = rightOfDprev;
        edge = dprev;
      } else if (rightOfCurr === 0) {
        const d = this.vtx[this.edgeDst(onext)];
        if (this.isRightOf(d.x, d.y, edge) >= 0) edge ^= 2;
        else {
          rightOfCurr = rightOfOnext;
          edge = onext;
        }
      } else {
        rightOfCurr = rightOfOnext;
        edge = onext;
      }
    }
    this.recentEdge = edge;
    if (loc === PTLOC_INSIDE) {
      const o = this.vtx[this.edgeOrg(edge)];
      const d = this.vtx[this.edgeDst(edge)];
      const t1 = Math.abs(x - o.x) + Math.abs(y - o.y);
      const t2 = Math.abs(x - d.x) + Math.abs(y - d.y);
      const t3 = Math.abs(o.x - d.x) + Math.abs(o.y - d.y);
      if (t1 < FLT_EPSILON) {
        loc = PTLOC_VERTEX;
        vertex = this.edgeOrg(edge);
        edge = 0;
      } else if (t2 < FLT_EPSILON) {
        loc = PTLOC_VERTEX;
        vertex = this.edgeDst(edge);
        edge = 0;
      } else if ((t1 < t3 || t2 < t3) && Math.abs(triangleArea(x, y, o.x, o.y, d.x, d.y)) < FLT_EPSILON) {
        loc = PTLOC_ON_EDGE;
        vertex = 0;
      }
    }
    if (loc === PTLOC_ERROR) {
      edge = 0;
      vertex = 0;
    }
    return { loc, edge, vertex };
  }

  private inCircle(p: Vertex, a: Vertex, b: Vertex, c: Vertex): number {
    const eps = FLT_EPSILON * 0.125;
    let v = (a.x * a.x + a.y * a.y) * triangleArea(b.x, b.y, c.x, c.y, p.x, p.y);
    v -= (b.x * b.x + b.y * b.y) * triangleArea(a.x, a.y, c.x, c.y, p.x, p.y);
    v += (c.x * c.x + c.y * c.y) * triangleArea(a.x, a.y, b.x, b.y, p.x, p.y);
    v -= (p.x * p.x + p.y * p.y) * triangleArea(a.x, a.y, b.x, b.y, c.x, c.y);
    return v > eps ? 1 : v < -eps ? -1 : 0;
  }

  /** Subdiv2D::insert (point as float32) */
  insert(px: number, py: number): number {
    const x = f(px);
    const y = f(py);
    const l = this.locate(x, y);
    if (l.loc === PTLOC_ERROR) throw new Error('Subdiv2D: point not located');
    if (l.loc === PTLOC_VERTEX) return l.vertex;
    let currEdge = l.edge;
    if (l.loc === PTLOC_ON_EDGE) {
      const deleted = currEdge;
      this.recentEdge = currEdge = this.getEdge(currEdge, PREV_AROUND_ORG);
      this.deleteEdge(deleted);
    }
    const currPoint = this.newPoint(x, y, false);
    let base = this.newEdge();
    const firstPoint = this.edgeOrg(currEdge);
    this.setEdgePoints(base, firstPoint, currPoint);
    this.splice(base, currEdge);
    do {
      base = this.connectEdges(currEdge, base ^ 2);
      currEdge = this.getEdge(base, PREV_AROUND_ORG);
    } while (this.edgeDst(currEdge) !== firstPoint);
    currEdge = this.getEdge(base, PREV_AROUND_ORG);
    const maxEdges = this.qedges.length * 4;
    for (let i = 0; i < maxEdges; i++) {
      const temp = this.getEdge(currEdge, PREV_AROUND_ORG);
      const tempDst = this.edgeDst(temp);
      const currOrg = this.edgeOrg(currEdge);
      const currDst = this.edgeDst(currEdge);
      const td = this.vtx[tempDst];
      if (this.isRightOf(td.x, td.y, currEdge) > 0 && this.inCircle(this.vtx[currOrg], td, this.vtx[currDst], this.vtx[currPoint]) < 0) {
        this.swapEdges(currEdge);
        currEdge = this.getEdge(currEdge, PREV_AROUND_ORG);
      } else if (currOrg === firstPoint) break;
      else currEdge = this.getEdge(this.nextEdge(currEdge), PREV_AROUND_LEFT);
    }
    return currPoint;
  }

  /** Subdiv2D::getTriangleList: triangles whose corners are all inside the rectangle, as corner coordinates */
  getTriangleList(): [Pt, Pt, Pt][] {
    const total = this.qedges.length * 4;
    const mask = new Uint8Array(total);
    // Rect2f(topLeft, bottomRight - topLeft).contains (float32 arithmetic)
    const rw = f(this.brx - this.tlx);
    const rh = f(this.bry - this.tly);
    const xe = f(this.tlx + rw);
    const ye = f(this.tly + rh);
    const inside = (v: Vertex) => this.tlx <= v.x && v.x < xe && this.tly <= v.y && v.y < ye;
    const out: [Pt, Pt, Pt][] = [];
    for (let i = 4; i < total; i += 2) {
      if (mask[i]) continue;
      const ea = i;
      const a = this.vtx[this.edgeOrg(ea)];
      if (!inside(a)) continue;
      const eb = this.getEdge(ea, NEXT_AROUND_LEFT);
      const b = this.vtx[this.edgeOrg(eb)];
      if (!inside(b)) continue;
      const ec = this.getEdge(eb, NEXT_AROUND_LEFT);
      const c = this.vtx[this.edgeOrg(ec)];
      if (!inside(c)) continue;
      mask[ea] = 1;
      mask[eb] = 1;
      mask[ec] = 1;
      out.push([
        [a.x, a.y],
        [b.x, b.y],
        [c.x, c.y],
      ]);
    }
    return out;
  }
}
