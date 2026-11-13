/**
 * Plane geometry with 3×3 matrices (row-major, as flat arrays of 9 numbers): projective maps
 * (homographies) between quadrilaterals, and the rotations / flips of video frames.
 *
 * Used by the sheet-music photo reader (lib/omr) and by the hands video (lib/handcam). Pure, so it
 * is unit-tested without a browser.
 */
export type Mat3 = number[];
export type Pt = [number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 3x3 homography (row-major) mapping the 4 `from` points onto the 4 `to` points. */
export function homography(from: number[][], to: number[][]): Mat3 {
  // solve A h = b for h0..h7 (h8 = 1)
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

/** a · b */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/** a · b · c · … (applied right to left to a point) */
export function chain(...ms: Mat3[]): Mat3 {
  return ms.reduce((acc, m) => mul3(acc, m), IDENTITY);
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error('Matrix is not invertible');
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

/** Applies m to (x, y) with the projective divide. `w` is the divisor (≤ 0 means behind the camera). */
export function apply3(m: Mat3, x: number, y: number): { x: number; y: number; w: number } {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w, w };
}

export const applyPt = (m: Mat3, p: Pt): Pt => {
  const r = apply3(m, p[0], p[1]);
  return [r.x, r.y];
};

/** x' = sx·x + tx, y' = sy·y + ty */
export const affine = (sx: number, sy: number, tx: number, ty: number): Mat3 => [sx, 0, tx, 0, sy, ty, 0, 0, 1];

export const UNIT_SQUARE: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export type Rotation = 0 | 90 | 180 | 270;

/**
 * Display → coded, in NORMALIZED coordinates (0..1 on both axes). A video's display frame is its
 * coded frame turned clockwise by `rotation` (the container's rotation metadata), so for 90°:
 * coded x = display y, coded y = 1 − display x.
 */
export function displayToCoded(rotation: number): Mat3 {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, 1, 0, -1, 0, 1, 0, 0, 1];
    case 180:
      return [-1, 0, 1, 0, -1, 1, 0, 0, 1];
    case 270:
      return [0, -1, 1, 1, 0, 0, 0, 0, 1];
    default:
      return IDENTITY;
  }
}

/**
 * Oriented → display, normalized: the user's "Turn 180°" (camera facing the player) and "Mirror"
 * (a selfie camera), applied after the metadata rotation. The oriented frame is the display frame
 * turned and then mirrored.
 */
export function orientedToDisplay(turn: 0 | 180, mirror: boolean): Mat3 {
  // display → oriented: turn (x→1−x, y→1−y), then mirror (x→1−x)
  let m = IDENTITY;
  if (turn === 180) m = mul3([-1, 0, 1, 0, -1, 1, 0, 0, 1], m);
  if (mirror) m = mul3([-1, 0, 1, 0, 1, 0, 0, 0, 1], m);
  return invert3(m);
}
