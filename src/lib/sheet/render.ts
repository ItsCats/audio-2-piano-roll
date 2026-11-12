/**
 * On-screen sheet music (DOM): renders a Score with OpenSheetMusicDisplay, loaded lazily.
 *
 * A whole-song render blocks the page for over a second on long Hard pieces, so the score is cut
 * into chunks of whole lines (our own line breaks, <print new-system>), each drawn by its own OSMD
 * instance. The chunk at the playback position is drawn first, the rest in order, yielding to the
 * browser between chunks. After each chunk is drawn, its measure boxes and note positions are
 * read from OSMD's graphical model into a time → position index (cursor, tap-to-seek); the OSMD
 * instance is then dropped and only its SVG stays in the page.
 *
 * OSMD's graphical classes (GraphicSheet.MeasureList, PositionAndShape) are used only here;
 * the package version is pinned exactly.
 */
import { lineBudget, systemBreaks } from './layout';
import { toMusicXml } from './musicxml';
import type { Score } from './types';

type OsmdModule = typeof import('opensheetmusicdisplay');
let osmdModule: Promise<OsmdModule> | null = null;
/** Loads the notation library (a separate chunk). */
export function loadOsmd(): Promise<OsmdModule> {
  osmdModule ??= import('opensheetmusicdisplay').catch((e) => {
    osmdModule = null;
    throw e;
  });
  return osmdModule;
}

/**
 * OSMD stops drawing the "3" of triplets after two in a row (for the rest of the piece); our
 * triplets have no bracket, so without the number they read as plain 8ths. Mark every one.
 */
export function showAllTupletNumbers(osmd: { EngravingRules: { TupletNumberLimitConsecutiveRepetitions: boolean; TupletNumberAlwaysDisableAfterFirstMax: boolean } }): void {
  osmd.EngravingRules.TupletNumberLimitConsecutiveRepetitions = false;
  osmd.EngravingRules.TupletNumberAlwaysDisableAfterFirstMax = false;
}

export interface MeasureBox {
  measure: number;
  t0: number;
  t1: number;
  /** Content coordinates (px) inside the host (which must be position: relative). */
  x: number;
  w: number;
  top: number;
  bottom: number;
  /** Note positions inside the measure, sorted by time. */
  entries: { t: number; x: number }[];
}

export interface CursorPos {
  x: number;
  top: number;
  bottom: number;
  box: MeasureBox;
}

interface Chunk {
  from: number;
  to: number;
  lines: number;
  el: HTMLDivElement;
  done: boolean;
}

const yieldToMain = (): Promise<void> => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((r) => setTimeout(r, 0));
};

export interface RenderOptions {
  zoom: number;
  /** Chunk to draw first: the one holding this song time. */
  startTime?: number;
  /** Lines per OSMD instance (default 2). */
  linesPerChunk?: number;
  onChunk?: (done: number, total: number) => void;
  /**
   * Keep the music on screen while the new one is drawn, and swap it in when complete (a new
   * width, zoom or edited notes of the same level). Otherwise each chunk shows as soon as it is
   * drawn (first draw, another level or song).
   */
  keepOld?: boolean;
}

/** Index of the measure holding a song time. */
function measureAtTime(s: Score, t: number): number {
  const ts = s.measureStartTimes;
  let lo = 0;
  let hi = s.measureCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Draws one Score into a container and answers time ↔ position questions about it. */
export class SheetRenderer {
  private chunks: Chunk[] = [];
  private boxes: (MeasureBox | undefined)[] = [];
  private token = 0;
  private lineHeight = 0;
  private score: Score | null = null;
  /** Longest single chunk draw (ms) of the last render, for measurements. */
  maxChunkMs = 0;

  constructor(readonly host: HTMLElement) {}

  get measureCount(): number {
    return this.score?.measureCount ?? 0;
  }

  /** Cancels any drawing in progress (a new render does this too). */
  cancel(): void {
    this.token++;
    this.staging?.remove();
    this.staging = null;
  }

  destroy(): void {
    this.cancel();
    this.staging = null;
    this.host.replaceChildren();
    this.chunks = [];
    this.boxes = [];
  }

  /**
   * Renders progressively. Resolves when all chunks are drawn, or early (false) when cancelled by
   * a newer render. `title` is drawn by the app, not by OSMD (OSMD's title overflows on phones).
   */
  async render(score: Score, opts: RenderOptions): Promise<boolean> {
    const token = ++this.token;
    performance.mark('sheet:render-start');
    const { OpenSheetMusicDisplay } = await loadOsmd();
    performance.mark('sheet:library-ready');
    if (token !== this.token) return false;
    const width = Math.max(240, this.host.clientWidth);
    const zoom = opts.zoom;
    const starts = systemBreaks(score, lineBudget(width - 20 * zoom, zoom));
    const per = Math.max(1, opts.linesPerChunk ?? 2);
    const chunks: Chunk[] = [];
    const frag = document.createDocumentFragment();
    const estLine = this.lineHeight || 190 * zoom;
    for (let i = 0; i < starts.length; i += per) {
      const el = document.createElement('div');
      el.className = 'sheet-chunk';
      el.style.position = 'relative';
      const lines = Math.min(per, starts.length - i);
      el.style.minHeight = `${Math.round(estLine * lines)}px`;
      chunks.push({ from: starts[i], to: starts[i + per] ?? score.measureCount, lines, el, done: false });
      frag.appendChild(el);
    }
    // keepOld: the new chunks are drawn in a hidden layer over the old music, swapped in at the end
    this.staging?.remove();
    this.staging = null;
    const staged = !!opts.keepOld && this.chunks.some((c) => c.done);
    let layer: HTMLElement = this.host;
    if (staged) {
      layer = document.createElement('div');
      layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;visibility:hidden;pointer-events:none';
      layer.setAttribute('aria-hidden', 'true');
      layer.appendChild(frag);
      this.host.appendChild(layer);
      this.staging = layer;
    } else {
      this.host.replaceChildren(frag);
      this.chunks = chunks;
      this.boxes = new Array(score.measureCount);
      this.score = score;
    }
    const boxes: (MeasureBox | undefined)[] = new Array(score.measureCount);
    this.maxChunkMs = 0;
    const startM = opts.startTime !== undefined ? measureAtTime(score, opts.startTime) : 0;
    const first = Math.max(0, chunks.findIndex((c) => startM < c.to));
    const order = [first, ...chunks.map((_, i) => i).filter((i) => i !== first)];
    let done = 0;
    for (const i of order) {
      if (token !== this.token) return false;
      const c = chunks[i];
      const t0 = performance.now();
      const osmd = new OpenSheetMusicDisplay(c.el, {
        autoResize: false,
        backend: 'svg',
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawCredits: false,
        drawPartNames: false,
        drawPartAbbreviations: false,
        drawMeasureNumbersOnlyAtSystemStart: true,
        newSystemFromXML: true,
        drawingParameters: 'compacttight',
        followCursor: false,
        disableCursor: true,
        autoBeam: false,
        stretchLastSystemLine: c.to < score.measureCount,
      });
      showAllTupletNumbers(osmd);
      const xml = toMusicXml(score, { title: '', from: c.from, to: c.to, breaks: starts });
      if (!done) performance.mark('sheet:first-xml');
      await osmd.load(xml);
      if (!done) performance.mark('sheet:first-loaded');
      if (token !== this.token) return false;
      osmd.zoom = zoom; // must be set after load()
      osmd.render();
      c.el.style.minHeight = '';
      c.done = true;
      this.indexChunk(osmd, c, score, boxes, layer);
      if (!staged) this.copyBoxes(boxes, c);
      this.maxChunkMs = Math.max(this.maxChunkMs, performance.now() - t0);
      if (!this.lineHeight || i === first) this.lineHeight = c.el.offsetHeight / c.lines;
      done++;
      if (done === 1) performance.mark('sheet:first-chunk');
      if (done === chunks.length) performance.mark('sheet:all-chunks');
      if (!staged || done === chunks.length) opts.onChunk?.(done, chunks.length);
      await yieldToMain();
    }
    if (token !== this.token) return false;
    if (staged) {
      // swap in the new music in one go
      this.staging = null;
      this.host.replaceChildren(...chunks.map((c) => c.el));
      this.chunks = chunks;
      this.boxes = boxes;
      this.score = score;
    }
    return true;
  }

  private staging: HTMLElement | null = null;

  private copyBoxes(boxes: (MeasureBox | undefined)[], c: Chunk): void {
    for (let m = c.from; m < c.to; m++) this.boxes[m] = boxes[m];
  }

  /** Reads measure boxes and note x positions of a freshly drawn chunk. */
  private indexChunk(osmd: InstanceType<OsmdModule['OpenSheetMusicDisplay']>, c: Chunk, score: Score, boxes: (MeasureBox | undefined)[], layer: HTMLElement): void {
    const t = score.time;
    const svg = c.el.querySelector('svg');
    if (!svg) return;
    // x relative to the host, y relative to the chunk (chunks above may still change height)
    const hostRect = layer.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const ox = svgRect.left - hostRect.left - layer.clientLeft;
    const oy = svgRect.top - c.el.getBoundingClientRect().top;
    const unit = 10 * osmd.zoom;
    const list = osmd.GraphicSheet?.MeasureList ?? [];
    for (let i = 0; i < list.length; i++) {
      const staves = list[i];
      const top = staves?.[0];
      const bot = staves?.[staves.length - 1];
      if (!top || !bot) continue;
      const m = c.from + i;
      if (m >= c.to) break;
      const ps = top.PositionAndShape;
      const x = ox + ps.AbsolutePosition.x * unit;
      const w = ps.Size.width * unit;
      const yTop = oy + ps.AbsolutePosition.y * unit;
      const yBot = oy + (bot.PositionAndShape.AbsolutePosition.y + 4) * unit;
      const ms = t.measureStart(m);
      const entries: { t: number; x: number }[] = [];
      const seen = new Set<number>();
      for (const gm of staves) {
        for (const se of gm?.staffEntries ?? []) {
          const rel = se.relInMeasureTimestamp?.RealValue ?? 0;
          const pos = ms + Math.round(rel * 48);
          if (seen.has(pos)) continue;
          seen.add(pos);
          entries.push({ t: t.posToTime(pos), x: ox + se.PositionAndShape.AbsolutePosition.x * unit });
        }
      }
      entries.sort((a, b) => a.t - b.t);
      boxes[m] = { measure: m, t0: score.measureStartTimes[m], t1: score.measureStartTimes[m + 1], x, w, top: yTop, bottom: yBot, entries };
    }
  }

  private chunkOf(m: number): Chunk | undefined {
    return this.chunks.find((ch) => m >= ch.from && m < ch.to);
  }

  measureAt(t: number): number {
    return this.score ? measureAtTime(this.score, t) : 0;
  }

  /** Measure box in host coordinates, or null while it isn't drawn yet. */
  box(m: number): MeasureBox | null {
    const b = this.boxes[m];
    if (!b) return null;
    const dy = this.chunkOf(m)?.el.offsetTop ?? 0;
    return { ...b, top: b.top + dy, bottom: b.bottom + dy };
  }

  /** The cursor for a song time, or null while that part isn't drawn yet. */
  cursorAt(t: number): CursorPos | null {
    const m = this.measureAt(t);
    const b = this.box(m);
    if (!b) return null;
    const es = b.entries;
    let x = b.x + 4;
    if (es.length) {
      let i = es.length - 1;
      while (i > 0 && es[i].t > t) i--;
      const a = es[i];
      if (t <= a.t) x = a.x;
      else {
        const nx = es[i + 1]?.x ?? b.x + b.w - 4;
        const nt = es[i + 1]?.t ?? b.t1;
        const f = nt > a.t ? Math.min(1, (t - a.t) / (nt - a.t)) : 0;
        x = a.x + (nx - a.x) * f;
      }
    }
    return { x, top: b.top, bottom: b.bottom, box: b };
  }

  /**
   * Song time for a tap at content coordinates (x, y), or null when nothing is there. The line
   * whose staves contain y wins; a tap just above or below a line (up to 35 % of its height) goes
   * to the nearest line.
   */
  timeAtPoint(x: number, y: number): number | null {
    let best: MeasureBox | null = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (let m = 0; m < this.boxes.length; m++) {
      const b = this.box(m);
      if (!b) continue;
      const pad = (b.bottom - b.top) * 0.35;
      const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      if (dy > pad) continue;
      const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
      if (dy < bestDy - 0.5 || (Math.abs(dy - bestDy) <= 0.5 && dx < bestDx)) {
        bestDy = dy;
        bestDx = dx;
        best = b;
      }
    }
    if (!best || bestDx > 24) return null;
    let t = best.t0;
    let d = Infinity;
    for (const e of best.entries) {
      const dd = Math.abs(e.x - x);
      if (dd < d) {
        d = dd;
        t = e.t;
      }
    }
    return t;
  }

  /** Top (content px) of the line holding measure m, for scrolling. */
  lineTopOf(m: number): number | null {
    const b = this.box(m);
    if (b) return b.top;
    const c = this.chunkOf(m);
    return c ? c.el.offsetTop : null;
  }
}
