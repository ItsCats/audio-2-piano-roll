/**
 * Puts the hands video into a frame drawn by the piano-roll renderer (export, export preview, setup).
 *
 * 'bottom' (like the big piano channels): the straightened camera keyboard fills the bottom of the
 * frame, the falling notes use its keys as lanes and land on them, and the drawn keyboard is hidden
 * (the renderer gets a stage, see RendererStage). 'pip': a small video in a corner over the normal roll.
 */
import type { Mat3 } from '../geom/homography';
import type { Ctx2D } from '../render/color';
import type { RendererStage } from '../render/renderer';
import { calibratedLayout, coverMatrix, frameMatrix, outputGeometry, pipRect, windowAspect, windowMatrix, type HandsGeometry, type Rect } from './calibration';
import type { Corner, KeyboardCalibration } from './types';
import { createWarper, type Warper } from './warp';

export interface ComposeSetup {
  layout: 'bottom' | 'pip';
  /** required for 'bottom'; optional for 'pip' (then the whole frame is shown) */
  cal?: KeyboardCalibration;
  /** the video's frame size as shown */
  display: { w: number; h: number };
  pipCorner?: Corner;
  pipSize?: number;
  /** room kept under the band for the watermark ('bottom') */
  wmBand?: number;
  /** room kept under a bottom picture-in-picture (the Studio keyboard, the watermark) */
  pipBottom?: number;
  /** lowest and highest note of the song ("just the keys in this song") */
  song?: { lo: number; hi: number } | null;
  /** thin light line where the notes land */
  hitLine?: boolean;
}

export class HandsCompositor {
  readonly geom: HandsGeometry | null = null;
  readonly pip: Rect | null = null;
  private warper: Warper;
  private matrices = new Map<number, Mat3>();
  private shown = false;
  private alpha = 1;
  constructor(
    readonly W: number,
    readonly H: number,
    private setup: ComposeSetup,
    opts: { force2d?: boolean } = {},
  ) {
    if (setup.layout === 'bottom') {
      if (!setup.cal) throw new Error('Set up the keyboard in your video first.');
      this.geom = outputGeometry(W, H, setup.cal, { wmBand: setup.wmBand, song: setup.song });
      this.warper = createWarper(W, Math.ceil(this.geom.bandH), opts);
    } else {
      const aspect = setup.cal ? windowAspect(setup.cal) : setup.display.w / Math.max(1, setup.display.h);
      this.pip = pipRect(W, H, setup.pipCorner ?? 'br', setup.pipSize ?? 0.3, aspect, setup.pipBottom ?? 0);
      this.warper = createWarper(this.pip.w, this.pip.h, opts);
    }
  }

  get warpKind(): 'webgl' | '2d' {
    return this.warper.kind;
  }

  private matrix(rotation: number): Mat3 {
    let m = this.matrices.get(rotation);
    if (!m) {
      const { cal, display } = this.setup;
      if (this.geom) m = frameMatrix(cal!, this.geom, rotation, this.geom.yTop);
      else if (cal) m = windowMatrix(cal, this.pip!.w, this.pip!.h, { ua: 0, ub: 1, v0: cal.hitV, v1: 1 + cal.hands }, rotation);
      else m = coverMatrix(this.pip!.w, this.pip!.h, display.w, display.h, rotation);
      this.matrices.set(rotation, m);
    }
    return m;
  }

  /**
   * The video frame to show (its pixels are copied: close a VideoFrame afterwards). `rotation`: how the
   * source's pixels are turned (a decoded VideoFrame: the file's rotation; a canvas from the preview
   * sink: 0). `alpha` fades the video out after its end. null: no frame (nothing is shown).
   */
  setFrame(src: TexImageSource | null, srcW: number, srcH: number, rotation: number, alpha = 1): void {
    this.alpha = alpha;
    if (!src) {
      this.warper.clear();
      this.shown = false;
      return;
    }
    this.warper.upload(src, srcW, srcH);
    this.redraw(rotation);
  }

  /** Draws the last frame again (same pixels, e.g. a new opacity). */
  redraw(rotation: number, alpha = this.alpha): void {
    this.alpha = alpha;
    const g = this.geom;
    if (g) {
      const fadeLen = Math.min(g.bandH * 0.35, 0.3 * g.kh);
      this.warper.draw(this.matrix(rotation), { clipX: [g.x0, g.x0 + g.Kw], fadeY: [g.bandH - fadeLen, g.bandH], alpha });
    } else this.warper.draw(this.matrix(rotation), { alpha: 1 });
    this.shown = true;
  }

  /** For 'bottom': the renderer stage (lanes on the real keys, the video instead of the keyboard). */
  stage(): RendererStage | null {
    const g = this.geom;
    const cal = this.setup.cal;
    if (!g || !cal) return null;
    const sc = this.H / 1080;
    return {
      layout: calibratedLayout(cal, g),
      hitY: g.yTop,
      kbH: g.kh * (1 - Math.max(0, cal.hitV)),
      paintKeys: (ctx: Ctx2D) => {
        if (this.shown) ctx.drawImage(this.warper.canvas as CanvasImageSource, 0, Math.round(g.yTop));
        if (this.setup.hitLine !== false) {
          ctx.save();
          const glow = ctx.createLinearGradient(0, g.yTop - 16 * sc, 0, g.yTop);
          glow.addColorStop(0, 'rgba(255,255,255,0)');
          glow.addColorStop(1, `rgba(255,255,255,${0.12 * this.alpha})`);
          ctx.fillStyle = glow;
          ctx.fillRect(g.x0, g.yTop - 16 * sc, g.Kw, 16 * sc);
          ctx.fillStyle = `rgba(255,255,255,${0.35 * this.alpha})`;
          ctx.fillRect(g.x0, g.yTop - Math.max(1, sc), g.Kw, Math.max(1, 1.5 * sc));
          ctx.restore();
        }
      },
    };
  }

  /** For 'pip': the small video in its corner (after the roll is drawn). */
  drawPip(ctx: Ctx2D): void {
    const r = this.pip;
    if (!r || !this.shown || this.alpha <= 0) return;
    const sc = this.H / 1080;
    const rad = 14 * sc;
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 24 * sc;
    ctx.shadowOffsetY = 6 * sc;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, rad);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.clip();
    ctx.drawImage(this.warper.canvas as CanvasImageSource, r.x, r.y);
    ctx.restore();
    ctx.lineWidth = Math.max(1, 2 * sc);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.stroke();
    ctx.restore();
  }

  dispose(): void {
    this.warper.dispose();
  }
}
