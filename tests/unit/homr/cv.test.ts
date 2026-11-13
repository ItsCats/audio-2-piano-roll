import { describe, expect, it } from 'vitest';
import {
  boxBlur,
  clahe,
  dilate,
  erode,
  fillConvexPoly,
  img,
  laplacianNoiseSum,
  rectKernel,
  resizeLinear,
  resizePil,
  structuringElement,
  toGray,
  warpAffine,
  type Img,
} from '../../../src/lib/omr/homr/cv';
import { loadCvFixtures, unpack } from './fixtures';

const ops = loadCvFixtures().ops;
const im = (o: { w: number; h: number; d: string }, c: number): Img => ({ w: o.w, h: o.h, c, d: unpack(o.d) });
const gray = im(ops.gray, 1);
const color = im(ops.color, 3);
const mask = im(ops.mask, 1);

/** largest absolute difference and the share of differing values */
function diff(a: Uint8Array, b: Uint8Array): { max: number; share: number } {
  expect(a.length).toBe(b.length);
  let max = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) n++;
    max = Math.max(max, d);
  }
  return { max, share: n / a.length };
}

describe('homr image operations vs cv2 / Pillow', () => {
  it('gray, CLAHE, blur and the noise measure are identical', () => {
    // the fixture is BGR (cv2); the port takes RGB
    const rgb = { ...color, d: color.d.slice() };
    for (let i = 0; i < rgb.d.length; i += 3) [rgb.d[i], rgb.d[i + 2]] = [rgb.d[i + 2], rgb.d[i]];
    expect(diff(toGray(rgb).d, unpack(ops.bgr2gray)).max).toBe(0);
    expect(diff(clahe(gray, 1, 8).d, unpack(ops.clahe)).max).toBe(0);
    expect(diff(boxBlur(color, 7).d, unpack(ops.blur7)).max).toBe(0);
    let k = 0;
    for (const y of [0, 25, 50]) for (const x of [0, 40]) expect(laplacianNoiseSum(gray, x, y, 30, 20)).toBe(ops.noise[k++]);
  });

  it("Pillow's bicubic resize (up and down) is identical", () => {
    expect(diff(resizePil(color, 71, 55).d, unpack(ops.pil_up.d)).max).toBe(0);
    expect(diff(resizePil(color, 40, 31).d, unpack(ops.pil_down.d)).max).toBe(0);
  });

  it("OpenCV's INTER_LINEAR resize is identical", () => {
    expect(diff(resizeLinear(gray, 61, 44).d, unpack(ops.lin_down.d)).max).toBe(0);
    expect(diff(resizeLinear(gray, 123, 90).d, unpack(ops.lin_up.d)).max).toBe(0);
  });

  it('structuring elements, erosion, dilation, closing', () => {
    for (const [key, m] of Object.entries(ops.kernels as Record<string, number[]>)) {
      const [w, h] = key.split('x').map(Number);
      expect(Array.from(structuringElement('ellipse', w, h).m)).toEqual(m);
    }
    expect(diff(dilate(mask, structuringElement('ellipse', 1, 2)).d, unpack(ops.dilate_1x2)).max).toBe(0);
    expect(diff(dilate(mask, structuringElement('ellipse', 5, 35)).d, unpack(ops.dilate_5x35)).max).toBe(0);
    expect(diff(erode(mask, structuringElement('ellipse', 1, 5)).d, unpack(ops.erode_1x5)).max).toBe(0);
    expect(diff(dilate(mask, rectKernel(3, 5)).d, unpack(ops.dilate_rect53)).max).toBe(0);
    expect(diff(erode(dilate(mask, rectKernel(7, 7)), rectKernel(7, 7)).d, unpack(ops.close7)).max).toBe(0);
    expect(diff(erode(mask, rectKernel(9, 9)).d, unpack(ops.erode9)).max).toBe(0);
  });

  it('warpAffine (bilinear, constant border) and fillConvexPoly', () => {
    const w = ops.warp;
    expect(diff(warpAffine(gray, w.m.flat(), w.w, w.h, 1).d, unpack(w.d)).max).toBe(0);
    const m = img(50, 40);
    fillConvexPoly(m, [[3, 2], [45, 9], [20, 37]], 255);
    const d = diff(m.d, unpack(ops.fillconvex));
    // the outline pixels may differ a little from OpenCV's line drawing
    expect(d.share).toBeLessThan(0.02);
  });
});
