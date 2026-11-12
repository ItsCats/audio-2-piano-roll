/**
 * Falling-note piano roll renderer (Canvas 2D).
 *
 * The same class renders the live Studio view and every frame of exported videos, so
 * exports match what users see. All animation (glow, sparks, trails) is a pure function of
 * song time, which keeps seeking stable and video export frame-exact.
 */
import type { Note, PedalRange, TempoInfo } from '../music/types';
import { formatLabel, isBlack, pitchClass, prefersFlats } from '../music/theory';
import { computeLayout, rangeFor, type KeyboardLayout } from './layout';
import { getBackgroundPreset } from './backgrounds';
import { PITCH_COLORS, type VisualSettings } from './settings';
import { BLACK_RGB, WHITE, hash, hexToRgb, makeCanvas, mix, rgba, roundRect, type AnyCanvas, type Ctx2D, type RGB } from './color';
import { getPatternTile, paintNoteDecal } from './decals';
import { DUST_LOOKBACK, FX_RELEASE, drawBursts, drawDust, drawKeyLight, type FxNote } from './effects';
import { drawRealisticKeyboard } from './keyboardRealistic';

export interface EditOverlay {
  selected: Set<number>;
  hover: number | null;
  /** grid line times (beats / subdivisions) */
  grid: { t: number; strong: boolean }[];
  ghost?: Note | null;
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface FrameOptions {
  time: number;
  /** keys currently held on a MIDI/computer keyboard */
  liveKeys?: Map<number, string>;
  /** practice feedback flashes */
  keyMarks?: Map<number, 'correct' | 'wrong'>;
  mutedHands?: { L: boolean; R: boolean };
  loop?: { start: number; end: number } | null;
  edit?: EditOverlay | null;
  countIn?: number;
  /** override for which notes are "active" (e.g. wait mode) */
  pedalOverride?: boolean;
}

export class PianoRollRenderer {
  readonly canvas: AnyCanvas;
  private ctx: Ctx2D;
  private w = 1;
  private h = 1;
  private notes: Note[] = [];
  private maxDur = 0;
  private pedal: PedalRange[] = [];
  private tempo: TempoInfo | null = null;
  private s: VisualSettings;
  private layout: KeyboardLayout;
  private bgMedia: CanvasImageSource | null = null;
  private bgMediaKind: 'image' | 'video' | null = null;
  private bgCache: AnyCanvas | null = null;
  private bgCacheKey = '';
  private decalImage: CanvasImageSource | null = null;
  private glowA: AnyCanvas | null = null;
  private glowB: AnyCanvas | null = null;
  private glowTiny: AnyCanvas | null = null;
  private decalImageSize = { w: 1, h: 1 };
  private flats = false;
  private supportsFilter: boolean;

  constructor(canvas: AnyCanvas, settings: VisualSettings) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false }) as Ctx2D | null;
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.s = settings;
    this.supportsFilter = typeof (ctx as CanvasRenderingContext2D).filter === 'string';
    this.layout = computeLayout(1, 21, 108);
  }

  resize(w: number, h: number): void {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    if (W === this.w && H === this.h) return;
    this.w = W;
    this.h = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.relayout();
    this.bgCacheKey = '';
  }

  get width() {
    return this.w;
  }
  get height() {
    return this.h;
  }

  setNotes(notes: Note[], pedal: PedalRange[], tempo: TempoInfo | null, keyTonic?: { tonic: number; mode: 'major' | 'minor' }): void {
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.maxDur = this.notes.reduce((m, n) => Math.max(m, n.dur), 0);
    this.pedal = pedal;
    this.tempo = tempo;
    if (keyTonic) this.flats = prefersFlats(keyTonic.tonic, keyTonic.mode);
    this.relayout();
  }

  setSettings(s: VisualSettings): void {
    const relayout = s.range !== this.s.range;
    this.s = s;
    if (relayout) this.relayout();
  }

  setBackgroundMedia(src: CanvasImageSource | null, kind: 'image' | 'video' | null): void {
    this.bgMedia = src;
    this.bgMediaKind = kind;
    this.bgCacheKey = '';
  }

  /** User-uploaded decal image (for decal.source === 'image'). */
  setDecalImage(img: CanvasImageSource | null, width = 1, height = 1): void {
    this.decalImage = img;
    this.decalImageSize = { w: Math.max(1, width), h: Math.max(1, height) };
  }

  private resolveDecal(): { img: CanvasImageSource; w: number; h: number } | null {
    const d = this.s.decal;
    if (d.source === 'pattern') {
      const tile = getPatternTile(d.patternId);
      return tile ? { img: tile, w: tile.width, h: tile.height } : null;
    }
    if (d.source === 'image' && this.decalImage) return { img: this.decalImage, ...this.decalImageSize };
    return null;
  }

  private relayout() {
    const [lo, hi] = rangeFor(this.s.range, this.notes);
    this.layout = computeLayout(this.w, lo, hi);
  }

  /** Geometry helpers (also used for hit testing in edit mode). */
  get scale(): number {
    return this.h / 1080;
  }
  get keyboardHeight(): number {
    return this.s.showKeyboard ? Math.round(this.h * this.s.keyboardHeight) : 0;
  }
  get hitY(): number {
    return this.h - this.keyboardHeight;
  }
  get pxPerSec(): number {
    return this.hitY / Math.max(0.5, this.s.lookahead);
  }
  get keyLayout(): KeyboardLayout {
    return this.layout;
  }
  timeToY(t: number, now: number): number {
    return this.hitY - (t - now) * this.pxPerSec;
  }
  yToTime(y: number, now: number): number {
    return now + (this.hitY - y) / this.pxPerSec;
  }
  noteRect(n: Note, now: number): { x: number; y: number; w: number; h: number } | null {
    const k = this.layout.keys[n.midi];
    if (!k) return null;
    const frac = k.black ? Math.min(1, this.s.noteWidth + 0.08) : this.s.noteWidth;
    const w = k.w * frac;
    const x = k.x + (k.w - w) / 2;
    const yb = this.timeToY(n.start, now);
    const yt = this.timeToY(n.start + n.dur, now);
    return { x, y: yt, w, h: Math.max(2, yb - yt) };
  }
  hitTest(x: number, y: number, now: number): { note: Note; edge: 'top' | 'bottom' | 'body' } | null {
    // iterate topmost (latest drawn) first; black keys drawn after white
    const t0 = now - this.maxDur - 1;
    const t1 = now + this.s.lookahead + 1;
    let best: { note: Note; edge: 'top' | 'bottom' | 'body' } | null = null;
    for (const n of this.notes) {
      if (n.start > t1) break;
      if (n.start + n.dur < t0) continue;
      const r = this.noteRect(n, now);
      if (!r) continue;
      const pad = 3;
      if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) {
        const edgeZone = Math.min(8, r.h / 4);
        const edge = y <= r.y + edgeZone ? 'top' : y >= r.y + r.h - edgeZone ? 'bottom' : 'body';
        if (!best || isBlack(n.midi)) best = { note: n, edge };
      }
    }
    return best;
  }

  private noteColor(n: Note): RGB {
    const s = this.s;
    if (s.colorMode === 'pitch') return hexToRgb(PITCH_COLORS[pitchClass(n.midi)]);
    if (s.colorMode === 'single') return hexToRgb(s.singleColor);
    return hexToRgb(n.hand === 'L' ? s.leftColor : s.rightColor);
  }

  /** Paints only the background (preset, colour, image or current video frame), e.g. for a title page. */
  drawBackdrop(ctx: Ctx2D): void {
    this.drawBackground(ctx);
  }

  private drawBackground(ctx: Ctx2D) {
    const b = this.s.background;
    const key = JSON.stringify([b, this.w, this.h, this.bgMediaKind === 'image' ? 1 : 0]);
    const isVideo = b.kind === 'video' && this.bgMediaKind === 'video' && this.bgMedia;
    if (!isVideo) {
      if (key !== this.bgCacheKey || !this.bgCache) {
        this.bgCache = makeCanvas(this.w, this.h);
        const c = this.bgCache.getContext('2d') as Ctx2D;
        this.paintBackground(c);
        this.bgCacheKey = key;
      }
      ctx.drawImage(this.bgCache, 0, 0);
      return;
    }
    this.paintBackground(ctx);
  }


  private paintBackground(c: Ctx2D) {
    const b = this.s.background;
    const { w, h } = this;
    c.save();
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    if (b.kind === 'color') {
      c.fillStyle = b.color;
      c.fillRect(0, 0, w, h);
    } else if ((b.kind === 'image' || b.kind === 'video') && this.bgMedia) {
      const src = this.bgMedia as HTMLImageElement & HTMLVideoElement & VideoFrame;
      const sw = src.videoWidth || src.naturalWidth || src.displayWidth || (src as unknown as { width: number }).width || 1;
      const sh = src.videoHeight || src.naturalHeight || src.displayHeight || (src as unknown as { height: number }).height || 1;
      const fit = b.fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
      const scale = fit * b.scale;
      const dw = sw * scale;
      const dh = sh * scale;
      const dx = (w - dw) * b.posX;
      const dy = (h - dh) * b.posY;
      c.globalAlpha = b.opacity;
      if (this.supportsFilter) {
        (c as CanvasRenderingContext2D).filter =
          `blur(${b.blur * this.scale}px) brightness(${b.brightness}) contrast(${b.contrast})`;
      }
      try {
        c.drawImage(src, dx, dy, dw, dh);
      } catch {
        /* media not ready yet */
      }
      if (this.supportsFilter) (c as CanvasRenderingContext2D).filter = 'none';
      c.globalAlpha = 1;
      if (!this.supportsFilter && b.brightness < 1) {
        c.fillStyle = `rgba(0,0,0,${1 - b.brightness})`;
        c.fillRect(0, 0, w, h);
      }
    } else {
      getBackgroundPreset(b.presetId).draw(c, w, h);
      if (b.brightness !== 1) {
        c.fillStyle = b.brightness < 1 ? `rgba(0,0,0,${1 - b.brightness})` : `rgba(255,255,255,${(b.brightness - 1) * 0.3})`;
        c.fillRect(0, 0, w, h);
      }
    }
    if (b.overlayOpacity > 0 && b.kind !== 'preset' && b.kind !== 'color') {
      c.fillStyle = rgba(hexToRgb(b.overlayColor), b.overlayOpacity);
      c.fillRect(0, 0, w, h);
    }
    c.restore();
  }

  render(opts: FrameOptions): void {
    const ctx = this.ctx;
    const s = this.s;
    const now = opts.time;
    const { w } = this;
    const sc = this.scale;
    const hitY = this.hitY;
    const kbH = this.keyboardHeight;
    const L = this.layout;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawBackground(ctx);

    // lane guides
    if (s.guides !== 'none') {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      if (s.guides === 'all') {
        for (let m = L.lo; m <= L.hi; m++) {
          const k = L.keys[m];
          if (k?.black) ctx.fillRect(k.x, 0, k.w, hitY);
        }
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = Math.max(1, sc);
      ctx.beginPath();
      for (let m = L.lo; m <= L.hi; m++) {
        if (m % 12 !== 0) continue;
        const k = L.keys[m];
        if (!k) continue;
        ctx.moveTo(Math.round(k.x) + 0.5, 0);
        ctx.lineTo(Math.round(k.x) + 0.5, hitY);
      }
      ctx.stroke();
    }

    // beat / bar lines
    if ((s.beatLines || opts.edit) && this.tempo?.beats.length) {
      const beats = this.tempo.beats;
      const tTop = this.yToTime(0, now);
      ctx.lineWidth = Math.max(1, sc);
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        if (b < now - 0.05 || b > tTop) continue;
        const y = Math.round(this.timeToY(b, now)) + 0.5;
        const bar = (i - this.tempo.downbeatIndex) % this.tempo.beatsPerBar === 0;
        ctx.strokeStyle = bar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }
    if (opts.edit) {
      ctx.lineWidth = 1;
      for (const g of opts.edit.grid) {
        if (g.strong) continue;
        const y = Math.round(this.timeToY(g.t, now)) + 0.5;
        if (y < 0 || y > hitY) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // loop region
    if (opts.loop) {
      const ya = this.timeToY(opts.loop.start, now);
      const yb = this.timeToY(opts.loop.end, now);
      ctx.fillStyle = 'rgba(120,160,255,0.06)';
      ctx.fillRect(0, Math.max(0, yb), w, Math.min(hitY, ya) - Math.max(0, yb));
      ctx.strokeStyle = 'rgba(140,170,255,0.6)';
      ctx.setLineDash([6 * sc, 6 * sc]);
      ctx.lineWidth = Math.max(1, 1.5 * sc);
      for (const y of [ya, yb]) {
        if (y < 0 || y > hitY) continue;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // pedal lane
    if (s.showPedal && this.pedal.length) {
      const laneW = Math.max(4, 6 * sc);
      ctx.fillStyle = 'rgba(200,205,215,0.13)';
      for (const p of this.pedal) {
        const y0 = this.timeToY(p.end, now);
        const y1 = this.timeToY(p.start, now);
        if (y1 < 0 || y0 > hitY) continue;
        ctx.fillRect(w - laneW - 2 * sc, Math.max(0, y0), laneW, Math.min(hitY, y1) - Math.max(0, y0) - 1);
      }
    }

    // visible notes
    const t0 = now - 0.05;
    const t1 = this.yToTime(-10, now);
    const visible: Note[] = [];
    let lo = 0;
    let hi = this.notes.length;
    const fx = s.effects;
    // ended notes stay relevant for dust, and briefly for the burst / key-light release
    const lookback = Math.max(fx.dust ? DUST_LOOKBACK : 0, fx.bursts || fx.keyLight ? FX_RELEASE : 0);
    const startFrom = now - this.maxDur - lookback - 0.1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].start < startFrom) lo = mid + 1;
      else hi = mid;
    }
    const active = new Map<number, Note>();
    const fxNotes: FxNote[] = [];
    for (let i = lo; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.start > t1) break;
      if (n.start <= now && n.start + n.dur > now - lookback && !opts.mutedHands?.[n.hand]) {
        const k = L.keys[n.midi];
        if (k) {
          fxNotes.push({ id: n.id, midi: n.midi, x: k.x + k.w / 2, w: k.w, black: k.black, color: this.noteColor(n), start: n.start, end: n.start + n.dur, vel: n.vel });
        }
      }
      if (n.start + n.dur < t0) continue;
      visible.push(n);
      if (n.start <= now && n.start + n.dur > now) {
        const prev = active.get(n.midi);
        if (!prev || n.start > prev.start) active.set(n.midi, n);
      }
    }

    if (s.fallingGlow > 0) this.drawFallingGlow(ctx, visible, now, opts);

    // light trails above active keys
    if (s.trails && s.glow > 0) {
      for (const n of active.values()) {
        const k = L.keys[n.midi];
        if (!k) continue;
        if (opts.mutedHands?.[n.hand]) continue;
        const c = this.noteColor(n);
        const age = now - n.start;
        const fade = Math.max(0.25, 1 - age * 0.8);
        const th = hitY * 0.35;
        const g = ctx.createLinearGradient(0, hitY - th, 0, hitY);
        g.addColorStop(0, rgba(c, 0));
        g.addColorStop(1, rgba(c, 0.22 * s.glow * fade));
        ctx.fillStyle = g;
        ctx.fillRect(k.x - k.w * 0.2, hitY - th, k.w * 1.4, th);
      }
    }

    // notes: white-key notes first so black-key notes sit on top
    const order = visible.sort((a, b) => Number(isBlack(a.midi)) - Number(isBlack(b.midi)));
    const radius = s.cornerRadius * sc;
    const labelSize = s.labels.size * sc;
    const showLabels = s.labels.style !== 'none';
    const flats = s.labels.accidentals === 'flats' || (s.labels.accidentals === 'auto' && this.flats);
    ctx.textAlign = 'center';
    const decal = this.resolveDecal();
    for (const n of order) {
      const r = this.noteRect(n, now);
      if (!r) continue;
      const muted = opts.mutedHands?.[n.hand];
      const isActive = active.get(n.midi) === n;
      const base = this.noteColor(n);
      let c = base;
      if (isActive) c = mix(base, WHITE, 0.25);
      else if (s.upcomingHighlight && n.start > now && n.start - now < 0.35) c = mix(base, WHITE, 0.12 * (1 - (n.start - now) / 0.35));
      if (s.noteBrightness > 0) c = mix(c, WHITE, s.noteBrightness * 0.28);
      const alpha = s.noteOpacity * (muted ? 0.22 : 1);
      ctx.globalAlpha = alpha;
      if (s.shadow && !muted) {
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 6 * sc;
        ctx.shadowOffsetY = 2 * sc;
      }
      if (isActive && s.glow > 0 && !muted) {
        ctx.shadowColor = rgba(base, 0.9);
        ctx.shadowBlur = 26 * sc * s.glow;
        ctx.shadowOffsetY = 0;
      }
      if (s.gradient) {
        const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
        g.addColorStop(0, rgba(mix(c, WHITE, 0.22), 1));
        g.addColorStop(1, rgba(mix(c, BLACK_RGB, 0.12), 1));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = rgba(c, 1);
      }
      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      if (decal) {
        paintNoteDecal(ctx, r, radius, {
          image: decal.img,
          imageWidth: decal.w,
          imageHeight: decal.h,
          settings: s.decal,
          color: c,
          noteId: n.id,
          anchorY: r.y + r.h,
          scale: sc,
          active: isActive,
        });
        roundRect(ctx, r.x, r.y, r.w, r.h, radius);
        if (s.noteBrightness > 0) {
          // lift the decal's colours so patterned notes pop as much as plain ones
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = rgba(c, 0.16 * s.noteBrightness);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      if (fx.outlineGlow > 0 && !muted) {
        ctx.save();
        ctx.shadowColor = `rgba(255,255,255,${0.55 + 0.4 * fx.outlineGlow})`;
        ctx.shadowBlur = (6 + 14 * fx.outlineGlow) * sc * (isActive ? 1.6 : 1);
        ctx.lineWidth = Math.max(1, (1 + 1.5 * fx.outlineGlow) * sc);
        ctx.strokeStyle = `rgba(255,255,255,${0.5 + 0.45 * fx.outlineGlow})`;
        ctx.stroke();
        ctx.restore();
      }
      if (s.borderWidth > 0) {
        ctx.lineWidth = s.borderWidth * sc;
        ctx.strokeStyle = rgba(hexToRgb(s.borderColor), isActive ? 0.55 : 0.22);
        ctx.stroke();
      }
      // edit selection
      if (opts.edit && (opts.edit.selected.has(n.id) || opts.edit.hover === n.id)) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(1.5, 2 * sc);
        ctx.strokeStyle = opts.edit.selected.has(n.id) ? '#ffffff' : 'rgba(255,255,255,0.55)';
        roundRect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, radius);
        ctx.stroke();
      }
      // label
      if (showLabels && r.h >= s.labels.minNoteHeight * sc && r.w >= labelSize * 0.8) {
        const text = formatLabel(n.midi, s.labels.style, flats ? 'flats' : 'sharps', s.labels.custom);
        if (text) {
          let size = labelSize;
          ctx.font = `${s.labels.bold ? 650 : 450} ${size}px ${s.labels.font}`;
          let tw = ctx.measureText(text).width;
          if (tw > r.w - 4 * sc) {
            size = Math.max(7 * sc, (size * (r.w - 4 * sc)) / tw);
            ctx.font = `${s.labels.bold ? 650 : 450} ${size}px ${s.labels.font}`;
            tw = ctx.measureText(text).width;
          }
          const pad = 4 * sc + size * 0.15;
          const ty =
            s.labels.position === 'bottom'
              ? Math.min(r.y + r.h, hitY) - pad
              : s.labels.position === 'top'
                ? Math.max(r.y, 0) + pad + size * 0.8
                : Math.max(r.y, 0) + (Math.min(r.y + r.h, hitY) - Math.max(r.y, 0)) / 2 + size * 0.35;
          if (ty > Math.max(r.y, 0) + size * 0.6 && ty < hitY) {
            ctx.globalAlpha = alpha * s.labels.opacity;
            ctx.fillStyle = s.labels.color;
            ctx.fillText(text, r.x + r.w / 2, ty);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // ghost note (edit: add preview)
    if (opts.edit?.ghost) {
      const r = this.noteRect(opts.edit.ghost, now);
      if (r) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = rgba(this.noteColor(opts.edit.ghost), 1);
        roundRect(ctx, r.x, r.y, r.w, r.h, radius);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    if (opts.edit?.marquee) {
      const m = opts.edit.marquee;
      ctx.fillStyle = 'rgba(120,160,255,0.12)';
      ctx.strokeStyle = 'rgba(140,170,255,0.8)';
      ctx.lineWidth = 1;
      const x = Math.min(m.x0, m.x1);
      const y = Math.min(m.y0, m.y1);
      ctx.fillRect(x, y, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }

    // sparks at the hit line (deterministic)
    if (s.particles && kbH > 0) {
      ctx.globalCompositeOperation = 'lighter';
      for (const n of active.values()) {
        if (opts.mutedHands?.[n.hand]) continue;
        const k = L.keys[n.midi];
        if (!k) continue;
        const c = mix(this.noteColor(n), WHITE, 0.35);
        const elapsed = now - n.start;
        const period = 0.07;
        const life = 0.45;
        const first = Math.max(0, Math.floor((elapsed - life) / period));
        const last = Math.floor(elapsed / period);
        for (let i = first; i <= last; i++) {
          const born = i * period;
          const age = elapsed - born;
          if (age < 0 || age > life || born > n.dur) continue;
          for (let j = 0; j < 2; j++) {
            const r1 = hash(n.id * 31 + i, j);
            const r2 = hash(n.id * 17 + j, i);
            const vx = (r1 - 0.5) * 140 * sc;
            const vy = -(120 + r2 * 220) * sc;
            const x = k.x + k.w / 2 + vx * age;
            const y = hitY + vy * age + 300 * sc * age * age;
            const a = (1 - age / life) * 0.9;
            ctx.fillStyle = rgba(c, a);
            const size = (1.2 + r2 * 1.8) * sc;
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // keyboard
    if (kbH > 0) {
      if (s.keyboardStyle === 'realistic') {
        drawRealisticKeyboard(ctx, L, this.keyColorFn(active, opts), {
          top: hitY,
          height: kbH,
          width: w,
          scale: sc,
          white: hexToRgb(s.whiteKeyColor),
          black: hexToRgb(s.blackKeyColor),
          border: s.keyBorderColor,
          showOctaveLabels: s.labels.showOnKeys,
          glow: s.glow,
          hitLine: s.hitLine,
        });
      } else {
        this.drawKeyboard(ctx, active, opts);
      }
    }

    // hit & ambience effects (pure functions of time)
    const geom = { width: w, height: this.h, hitY, kbH, scale: sc };
    if (fx.keyLight && kbH > 0) drawKeyLight(ctx, fxNotes, now, geom, fx);
    if (fx.bursts) drawBursts(ctx, fxNotes, now, geom, fx);
    if (fx.dust) drawDust(ctx, fxNotes, now, geom, fx);

    // pedal indicator
    const pedalDown = opts.pedalOverride ?? this.pedal.some((p) => p.start <= now && p.end > now);
    if (s.showPedal && this.pedal.length) {
      const pw = 46 * sc;
      const ph = 18 * sc;
      const px = w - pw - 10 * sc;
      const py = hitY - ph - 10 * sc;
      ctx.globalAlpha = pedalDown ? 0.95 : 0.35;
      ctx.fillStyle = pedalDown ? 'rgba(230,232,240,0.95)' : 'rgba(255,255,255,0.15)';
      roundRect(ctx, px, py, pw, ph, ph / 2);
      ctx.fill();
      ctx.fillStyle = pedalDown ? '#111' : '#fff';
      ctx.font = `650 ${11 * sc}px Inter Variable, Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('PED', px + pw / 2, py + ph * 0.7);
      ctx.globalAlpha = 1;
    }

    // count-in
    if (opts.countIn && opts.countIn > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `700 ${120 * sc}px Inter Variable, Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(opts.countIn), w / 2, hitY / 2);
    }
    ctx.restore();
  }

  /**
   * Soft halo in each note's colour while it falls, getting stronger as the note nears the
   * keys. All notes are drawn into a quarter-resolution layer that is blurred once and added
   * on top of the background, so the cost doesn't grow with the number of notes.
   */
  private drawFallingGlow(ctx: Ctx2D, notes: Note[], now: number, opts: FrameOptions): void {
    const s = this.s;
    const ds = 4;
    const gw = Math.ceil(this.w / ds);
    const gh = Math.ceil(this.hitY / ds);
    if (gw < 2 || gh < 2) return;
    const fit = (c: AnyCanvas | null) => {
      if (!c) return makeCanvas(gw, gh);
      if (c.width !== gw || c.height !== gh) {
        c.width = gw;
        c.height = gh;
      }
      return c;
    };
    this.glowA = fit(this.glowA);
    this.glowB = fit(this.glowB);
    const a = this.glowA.getContext('2d') as Ctx2D;
    const b = this.glowB.getContext('2d') as Ctx2D;
    a.clearRect(0, 0, gw, gh);
    const look = Math.max(0.5, s.lookahead);
    const sc = this.scale;
    const blurPx = (2.5 + 3.5 * s.fallingGlow) * sc; // in glow-layer pixels
    const margin = Math.ceil(blurPx * 2.5) * ds; // halo reach in screen pixels
    // screen regions that will actually receive glow (composited strip by strip below)
    const spans: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const n of notes) {
      if (opts.mutedHands?.[n.hand]) continue;
      const r = this.noteRect(n, now);
      if (!r || r.y > this.hitY || r.y + r.h < 0) continue;
      spans.push({ x0: r.x - margin, x1: r.x + r.w + margin, y0: r.y - margin, y1: r.y + r.h + margin });
      const proximity = n.start <= now ? 1 : Math.max(0, Math.min(1, 1 - (n.start - now) / look));
      a.globalAlpha = 0.4 + 0.6 * proximity;
      a.fillStyle = rgba(mix(this.noteColor(n), WHITE, 0.15), 1);
      a.fillRect(r.x / ds, r.y / ds, r.w / ds, r.h / ds);
    }
    a.globalAlpha = 1;
    if (!spans.length) return;
    b.clearRect(0, 0, gw, gh);
    if (typeof (b as CanvasRenderingContext2D).filter === 'string') {
      (b as CanvasRenderingContext2D).filter = `blur(${blurPx}px)`;
      b.drawImage(this.glowA, 0, 0);
      (b as CanvasRenderingContext2D).filter = 'none';
    } else {
      // no canvas filters (older Safari): blur by down- and up-sampling
      const tw = Math.max(1, Math.ceil(gw / 6));
      const th = Math.max(1, Math.ceil(gh / 6));
      if (!this.glowTiny) this.glowTiny = makeCanvas(tw, th);
      if (this.glowTiny.width !== tw || this.glowTiny.height !== th) {
        this.glowTiny.width = tw;
        this.glowTiny.height = th;
      }
      const t = this.glowTiny.getContext('2d') as Ctx2D;
      t.clearRect(0, 0, tw, th);
      t.imageSmoothingEnabled = true;
      t.drawImage(this.glowA, 0, 0, tw, th);
      b.imageSmoothingEnabled = true;
      b.drawImage(this.glowTiny, 0, 0, gw, gh);
      b.globalAlpha = 0.6;
      b.drawImage(this.glowA, 0, 0);
      b.globalAlpha = 1;
    }
    // Blending cost is proportional to the painted area, so only composite the vertical
    // strips that contain notes (merged by x, each spanning its notes' y-range).
    spans.sort((p, q) => p.x0 - q.x0);
    const merged: typeof spans = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && sp.x0 <= last.x1) {
        last.x1 = Math.max(last.x1, sp.x1);
        last.y0 = Math.min(last.y0, sp.y0);
        last.y1 = Math.max(last.y1, sp.y1);
      } else merged.push({ ...sp });
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, 0.25 + 0.75 * s.fallingGlow);
    ctx.imageSmoothingEnabled = true;
    for (const m of merged) {
      // align to the glow layer's pixel grid so neighbouring strips meet without seams
      const sx0 = Math.max(0, Math.floor(m.x0 / ds));
      const sx1 = Math.min(gw, Math.ceil(m.x1 / ds));
      const sy0 = Math.max(0, Math.floor(m.y0 / ds));
      const sy1 = Math.min(gh, Math.ceil(m.y1 / ds));
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      ctx.drawImage(this.glowB, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 * ds, sy0 * ds, (sx1 - sx0) * ds, (sy1 - sy0) * ds);
    }
    ctx.restore();
  }

  /** Highlight colour of each key (practice marks > live input > sounding note), or null. */
  private keyColorFn(active: Map<number, Note>, opts: FrameOptions): (m: number) => RGB | null {
    const s = this.s;
    return (m: number) => {
      const mark = opts.keyMarks?.get(m);
      if (mark === 'correct') return { r: 52, g: 211, b: 153 };
      if (mark === 'wrong') return { r: 248, g: 82, b: 82 };
      const live = opts.liveKeys?.get(m);
      if (live) return hexToRgb(live);
      const n = active.get(m);
      if (!n || opts.mutedHands?.[n.hand]) return null;
      return s.keyHighlight === 'custom' ? hexToRgb(s.keyHighlightColor) : this.noteColor(n);
    };
  }

  private drawKeyboard(ctx: Ctx2D, active: Map<number, Note>, opts: FrameOptions) {
    const s = this.s;
    const L = this.layout;
    const sc = this.scale;
    const top = this.hitY;
    const kbH = this.keyboardHeight;
    const white = hexToRgb(s.whiteKeyColor);
    const black = hexToRgb(s.blackKeyColor);
    const border = s.keyBorderColor;
    const blackH = kbH * 0.63;
    const keyColor = this.keyColorFn(active, opts);

    // felt strip + hit line
    const felt = Math.max(2, 5 * sc);
    ctx.fillStyle = '#4a1019';
    ctx.fillRect(0, top, this.w, felt);
    if (s.hitLine) {
      const g = ctx.createLinearGradient(0, top - 14 * sc, 0, top);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(255,255,255,0.10)');
      ctx.fillStyle = g;
      ctx.fillRect(0, top - 14 * sc, this.w, 14 * sc);
    }
    const ky = top + felt;
    const kh = kbH - felt;

    // white keys
    for (let m = L.lo; m <= L.hi; m++) {
      const k = L.keys[m];
      if (!k || k.black) continue;
      const hc = keyColor(m);
      const pressed = hc !== null;
      const c = pressed ? mix(hc!, white, 0.15) : white;
      const g = ctx.createLinearGradient(0, ky, 0, ky + kh);
      g.addColorStop(0, rgba(mix(c, BLACK_RGB, pressed ? 0.05 : 0.12), 1));
      g.addColorStop(0.12, rgba(c, 1));
      g.addColorStop(1, rgba(mix(c, BLACK_RGB, pressed ? 0.15 : 0.05), 1));
      ctx.fillStyle = g;
      const r = Math.min(4 * sc, k.w / 5);
      roundRect(ctx, k.x + 0.5, ky, k.w - 1, kh - (pressed ? 0 : 2 * sc), r);
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = Math.max(1, sc);
      ctx.stroke();
      if (s.labels.showOnKeys && m % 12 === 0 && k.w > 9 * sc) {
        ctx.fillStyle = pressed ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.38)';
        if (white.r + white.g + white.b < 300) ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = `600 ${Math.min(12 * sc, k.w * 0.45)}px Inter Variable, Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, k.x + k.w / 2, ky + kh - 8 * sc);
      }
      if (pressed && s.glow > 0) {
        const gg = ctx.createLinearGradient(0, ky, 0, ky + kh * 0.4);
        gg.addColorStop(0, rgba(hc!, 0.55 * s.glow));
        gg.addColorStop(1, rgba(hc!, 0));
        ctx.fillStyle = gg;
        ctx.fillRect(k.x, ky, k.w, kh * 0.4);
      }
    }
    // black keys
    for (let m = L.lo; m <= L.hi; m++) {
      const k = L.keys[m];
      if (!k || !k.black) continue;
      const hc = keyColor(m);
      const pressed = hc !== null;
      const c = pressed ? mix(hc!, BLACK_RGB, 0.15) : black;
      const g = ctx.createLinearGradient(0, ky, 0, ky + blackH);
      g.addColorStop(0, rgba(mix(c, BLACK_RGB, 0.25), 1));
      g.addColorStop(0.85, rgba(mix(c, WHITE, pressed ? 0.1 : 0.08), 1));
      g.addColorStop(1, rgba(mix(c, WHITE, pressed ? 0.2 : 0.18), 1));
      ctx.fillStyle = g;
      const r = Math.min(3 * sc, k.w / 5);
      roundRect(ctx, k.x, ky - 1, k.w, blackH - (pressed ? 0 : 2 * sc), r);
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = Math.max(1, sc);
      ctx.stroke();
      if (!pressed) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(k.x + k.w * 0.2, ky + blackH - 9 * sc, k.w * 0.6, 3 * sc);
      }
    }
    // top shadow over keys
    const sh = ctx.createLinearGradient(0, ky, 0, ky + 10 * sc);
    sh.addColorStop(0, 'rgba(0,0,0,0.35)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(0, ky, this.w, 10 * sc);
  }
}
