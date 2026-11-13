/**
 * Projective warp of a video frame into an output canvas: every output pixel looks up its source
 * texture coordinate through one 3×3 matrix (with the projective divide), so the camera's tilted
 * keyboard comes out straight. WebGL2 when available (about half a millisecond a frame); otherwise a
 * Canvas 2D mesh of small affine triangles.
 *
 * upload() takes a frame (VideoFrame, canvas, image) and keeps its pixels, so the caller can close a
 * VideoFrame right after; draw() can then run again (a 60 FPS export of a 30 FPS video uploads every
 * frame once).
 */
import type { Mat3 } from '../geom/homography';
import { apply3 } from '../geom/homography';

export const GRAPHICS_RESET_MESSAGE = 'The video effect stopped (graphics reset). Try again.';

export interface WarpOptions {
  /** output x range that may be painted (pillarbox outside) */
  clipX?: [number, number];
  /** output rows [from, to] over which the picture fades out (alpha 1 → 0) */
  fadeY?: [number, number];
  /** overall opacity */
  alpha?: number;
}

export interface Warper {
  readonly kind: 'webgl' | '2d';
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  resize(w: number, h: number): void;
  /** keeps the frame's pixels (the frame may be closed afterwards); false if there is nothing to show */
  upload(src: TexImageSource, srcW: number, srcH: number): boolean;
  /** paints the last uploaded frame through M (output px → texture 0..1); clears to transparent first */
  draw(M: Mat3, opts?: WarpOptions): void;
  clear(): void;
  dispose(): void;
}

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform mat3 M;
uniform vec2 outSize;
uniform vec2 clipX;
uniform vec2 fadeY;
uniform float alpha;
out vec4 o;
void main() {
  vec2 px = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);
  if (px.x < clipX.x || px.x > clipX.y) { o = vec4(0.0); return; }
  vec3 s = M * vec3(px, 1.0);
  if (s.z <= 0.0) { o = vec4(0.0); return; }
  vec2 uv = s.xy / s.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0); return; }
  float a = alpha;
  if (fadeY.y > fadeY.x) a *= 1.0 - smoothstep(fadeY.x, fadeY.y, px.y);
  o = vec4(texture(tex, uv).rgb * a, a);
}`;

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

class GlWarper implements Warper {
  readonly kind = 'webgl' as const;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private lost = false;
  private maxTex: number;
  private staging: OffscreenCanvas | HTMLCanvasElement | null = null;
  private hasFrame = false;
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    this.canvas = makeCanvas(this.width, this.height);
    const gl = (this.canvas as OffscreenCanvas).getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    (this.canvas as HTMLCanvasElement).addEventListener?.('webglcontextlost', (e: Event) => {
      e.preventDefault();
      this.lost = true;
    });
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (const n of ['M', 'outSize', 'clipX', 'fadeY', 'alpha', 'tex']) this.u[n] = gl.getUniformLocation(prog, n);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  }
  private check() {
    if (this.lost || this.gl.isContextLost()) throw new Error(GRAPHICS_RESET_MESSAGE);
  }
  resize(w: number, h: number) {
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;
  }
  upload(src: TexImageSource, srcW: number, srcH: number): boolean {
    this.check();
    const gl = this.gl;
    let source: TexImageSource = src;
    // larger than the GPU takes (4K on some phones): scale down first (the orientation stays the same)
    if (Math.max(srcW, srcH) > this.maxTex) {
      const k = this.maxTex / Math.max(srcW, srcH);
      const w = Math.floor(srcW * k);
      const h = Math.floor(srcH * k);
      this.staging ??= makeCanvas(w, h);
      this.staging.width = w;
      this.staging.height = h;
      (this.staging.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(src as CanvasImageSource, 0, 0, w, h);
      source = this.staging as TexImageSource;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.hasFrame = true;
    return true;
  }
  draw(M: Mat3, opts: WarpOptions = {}) {
    this.check();
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.hasFrame) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.u.M, true, new Float32Array(M));
    gl.uniform2f(this.u.outSize, this.width, this.height);
    gl.uniform2f(this.u.clipX, opts.clipX?.[0] ?? -1e9, opts.clipX?.[1] ?? 1e9);
    gl.uniform2f(this.u.fadeY, opts.fadeY?.[0] ?? 0, opts.fadeY?.[1] ?? 0);
    gl.uniform1f(this.u.alpha, opts.alpha ?? 1);
    gl.uniform1i(this.u.tex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  clear() {
    this.hasFrame = false;
    if (this.lost) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  dispose() {
    try {
      this.gl.deleteTexture(this.tex);
      this.gl.deleteProgram(this.prog);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* already gone */
    }
    this.staging = null;
  }
}

/** Affine map (a, b, c, d, e, f for setTransform) taking triangle s onto triangle d. */
export function triangleAffine(s: number[][], d: number[][]): [number, number, number, number, number, number] | null {
  const [x0, y0] = s[0];
  const [x1, y1] = s[1];
  const [x2, y2] = s[2];
  const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(den) < 1e-9) return null;
  const solve = (u0: number, u1: number, u2: number) => {
    const p = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den;
    const q = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den;
    return [p, q, u0 - p * x0 - q * y0];
  };
  const [a, c, e] = solve(d[0][0], d[1][0], d[2][0]);
  const [b, dd, f] = solve(d[0][1], d[1][1], d[2][1]);
  return [a, b, c, dd, e, f];
}

/** Canvas 2D fallback: a mesh of affine triangles (24 × 6 cells), close enough for a mild perspective. */
class MeshWarper implements Warper {
  readonly kind = '2d' as const;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private staging: OffscreenCanvas | HTMLCanvasElement | null = null;
  private sw = 0;
  private sh = 0;
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    this.canvas = makeCanvas(this.width, this.height);
  }
  private ctx() {
    return this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  }
  resize(w: number, h: number) {
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }
  upload(src: TexImageSource, srcW: number, srcH: number): boolean {
    const k = Math.min(1, 1920 / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * k));
    const h = Math.max(1, Math.round(srcH * k));
    this.staging ??= makeCanvas(w, h);
    if (this.staging.width !== w) this.staging.width = w;
    if (this.staging.height !== h) this.staging.height = h;
    (this.staging.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(src as CanvasImageSource, 0, 0, w, h);
    this.sw = w;
    this.sh = h;
    return true;
  }
  draw(M: Mat3, opts: WarpOptions = {}) {
    const ctx = this.ctx();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.staging) return;
    const x0 = Math.max(0, opts.clipX?.[0] ?? 0);
    const x1 = Math.min(this.width, opts.clipX?.[1] ?? this.width);
    const NX = 24;
    const NY = 6;
    const pt = (i: number, j: number) => [x0 + ((x1 - x0) * i) / NX, (this.height * j) / NY];
    const src = (p: number[]) => {
      const r = apply3(M, p[0], p[1]);
      return [r.x * this.sw, r.y * this.sh, r.w];
    };
    ctx.globalAlpha = opts.alpha ?? 1;
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
        for (const tri of [
          [q[0], q[1], q[2]],
          [q[0], q[2], q[3]],
        ]) {
          const s = tri.map(src);
          if (s.some((p) => p[2] <= 0)) continue;
          const A = triangleAffine(
            s.map((p) => [p[0], p[1]]),
            tri,
          );
          if (!A) continue;
          ctx.save();
          ctx.beginPath();
          // a hair larger, so neighboring triangles meet without seams
          const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
          const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
          tri.forEach((p, k) => {
            const x = p[0] + Math.sign(p[0] - cx) * 0.6;
            const y = p[1] + Math.sign(p[1] - cy) * 0.6;
            if (k) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.closePath();
          ctx.clip();
          ctx.setTransform(...A);
          ctx.drawImage(this.staging as CanvasImageSource, 0, 0);
          ctx.restore();
        }
      }
    ctx.globalAlpha = 1;
    if (opts.fadeY && opts.fadeY[1] > opts.fadeY[0]) {
      const g = ctx.createLinearGradient(0, opts.fadeY[0], 0, opts.fadeY[1]);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = g;
      ctx.fillRect(0, opts.fadeY[0], this.width, this.height - opts.fadeY[0]);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  clear() {
    this.staging = null;
    this.ctx().clearRect(0, 0, this.width, this.height);
  }
  dispose() {
    this.staging = null;
  }
}

/** WebGL2 when it works, else the Canvas 2D mesh. */
export function createWarper(w: number, h: number, opts: { force2d?: boolean } = {}): Warper {
  if (!opts.force2d) {
    try {
      return new GlWarper(w, h);
    } catch {
      /* no WebGL2 (or no WebGL2 on OffscreenCanvas): fall back */
    }
  }
  return new MeshWarper(w, h);
}
