/**
 * Draws a preview of an exported frame with the hands video and the watermark (the export dialog and
 * the hands video setup). Same code as the export (renderer + compositor + watermark painter), at a
 * smaller size. Keeps one compositor (one WebGL context) and rebuilds it only when its layout changes.
 */
import type { Difficulty, Song } from '../../lib/music/types';
import type { VisualSettings } from '../../lib/render/settings';
import { outputSize, type ExportSettings } from '../../lib/export/types';
import { exportVisual } from '../../lib/export/videoExport';
import { PianoRollRenderer } from '../../lib/render/renderer';
import { HandsCompositor } from '../../lib/handcam/compose';
import { noteSpan } from '../../lib/handcam/calibration';
import type { HandVideo, HandsLayout } from '../../lib/handcam/types';
import { watermarkActive, type WatermarkSettings } from '../../lib/watermark/types';
import { logoClearOf, watermarkBand } from '../../lib/watermark/layout';
import { watermarkPainter } from '../../lib/watermark/draw';

export interface PreviewScene {
  song: Song;
  difficulty: Difficulty;
  /** the Studio look (export options are applied here) */
  visual: VisualSettings;
  settings: ExportSettings;
  /** song time */
  time: number;
  layout: HandsLayout;
  hv?: HandVideo | null;
  /** the video frame (as shown: rotation applied), or null */
  frame?: CanvasImageSource | null;
  frameW?: number;
  frameH?: number;
  watermark?: WatermarkSettings | null;
  logo?: ImageBitmap | HTMLImageElement | null;
  bg?: { source: CanvasImageSource; kind: 'image' | 'video' } | null;
  decal?: { source: CanvasImageSource; width: number; height: number } | null;
}

export class PreviewPainter {
  private comp: HandsCompositor | null = null;
  private compKey = '';
  constructor(private maxSide = 720) {}

  paint(canvas: HTMLCanvasElement, sc: PreviewScene): void {
    const out = outputSize(sc.settings);
    const scale = Math.min(1, this.maxSide / Math.max(out.width, out.height));
    const W = Math.round(out.width * scale);
    const H = Math.round(out.height * scale);
    const layout = sc.hv ? sc.layout : 'off';
    const visual = exportVisual({ visual: sc.visual, settings: sc.settings }, layout === 'bottom' && sc.hv?.calibration ? 'bottom' : 'off');
    const r = new PianoRollRenderer(canvas, visual);
    r.resize(W, H);
    const arr = sc.song.arrangements[sc.difficulty];
    r.setNotes(arr.notes, arr.pedal, sc.song.tempo, sc.song.key);
    if (sc.bg) r.setBackgroundMedia(sc.bg.source, sc.bg.kind);
    if (sc.decal) r.setDecalImage(sc.decal.source, sc.decal.width, sc.decal.height);
    const wm = sc.watermark && watermarkActive(sc.watermark) ? logoClearOf(sc.watermark, layout === 'pip' ? (sc.settings.pipCorner ?? 'br') : null) : null;
    const bottom = layout === 'bottom' && !!sc.hv?.calibration;
    const wmBand = wm && bottom ? watermarkBand(wm, W, H) : 0;
    const drawnKeys = visual.showKeyboard ? Math.round(H * visual.keyboardHeight) : 0;
    let comp: HandsCompositor | null = null;
    if (sc.hv && (bottom || layout === 'pip')) {
      const pipBottom = drawnKeys + (wm && wm.position[0] === 'b' ? Math.round(2.6 * 26 * (Math.min(W, H) / 1080) * wm.size) : 0);
      const key = JSON.stringify([W, H, bottom ? 'bottom' : 'pip', sc.hv.calibration, sc.hv.displayW, sc.hv.displayH, sc.settings.pipCorner, sc.settings.pipSize, wmBand, pipBottom, noteSpan(arr.notes), visual.hitLine]);
      if (key !== this.compKey) {
        this.comp?.dispose();
        this.comp = null;
        try {
          this.comp = new HandsCompositor(W, H, {
            layout: bottom ? 'bottom' : 'pip',
            cal: sc.hv.calibration,
            display: { w: sc.hv.displayW, h: sc.hv.displayH },
            pipCorner: sc.settings.pipCorner,
            pipSize: sc.settings.pipSize,
            wmBand,
            pipBottom,
            song: noteSpan(arr.notes),
            hitLine: visual.hitLine,
          });
        } catch {
          this.comp = null;
        }
        this.compKey = key;
      }
      comp = this.comp;
      if (comp) {
        const tv = sc.time + sc.hv.offset;
        const alpha = tv > sc.hv.duration ? Math.max(0, 1 - (tv - sc.hv.duration) / 0.5) : 1;
        comp.setFrame((sc.frame as TexImageSource) ?? null, sc.frameW ?? 1, sc.frameH ?? 1, 0, alpha);
        if (bottom) r.setStage(comp.stage());
      }
    }
    r.render({ time: sc.time });
    const ctx = canvas.getContext('2d')!;
    if (comp && layout === 'pip') comp.drawPip(ctx);
    if (wm) watermarkPainter(wm, W, H, ctx, { band: wmBand, avoidBottom: bottom ? 0 : drawnKeys, logo: sc.logo ?? null, logoAspect: sc.logo ? sc.logo.width / Math.max(1, sc.logo.height) : 1 }).draw(ctx);
  }

  dispose(): void {
    this.comp?.dispose();
    this.comp = null;
    this.compKey = '';
  }
}
