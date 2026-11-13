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
import { alterAt, diatonicAtY, diatonicToMidi, ottavaAt, yOfDiatonic } from './pitch';
import { snapPos } from './edit';
import { writtenIndex, writtenKey } from './written';
import type { Score, Staff } from './types';

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
  entries: { t: number; x: number; pos?: number }[];
  /** y (content px) of the top line of each staff, and the line gap (px). */
  staffTop?: [number, number];
  gap?: number;
}

/** A drawn notehead (or chord tone), matched to the written note it shows. */
export interface NoteHit {
  /** writtenIndex key ('' when it couldn't be matched). */
  key: string;
  ids: number[];
  measure: number;
  staff: Staff;
  voice: number;
  pos: number;
  midi: number;
  /** Notehead centre and box: x in host coordinates, y relative to the chunk. */
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  heads: Element[];
}

/** A slot on the staff for a new note. */
export interface SheetSlot {
  measure: number;
  staff: Staff;
  pos: number;
  midi: number;
  /** Diatonic number shown (for ledger lines). */
  dn: number;
  /** Host coordinates of the notehead centre, and the staff's top line and gap. */
  x: number;
  y: number;
  staffTop: number;
  gap: number;
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
  /** The MusicXML it was drawn from (a redraw after an edit skips chunks whose XML is unchanged). */
  xml?: string;
  hits: NoteHit[];
}

interface RawHit {
  gn: { sourceNote?: unknown };
  m: number;
  staff: Staff;
  pos: number;
}

/** Names the notes a drawn notehead stands for (data-note-ids), for tools and tests. */
function tagHeads(h: NoteHit): void {
  for (const el of h.heads) el.setAttribute?.('data-note-ids', h.ids.join(','));
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
  /**
   * An edit on the sheet: keep the line breaks while they fit, and redraw only the chunks whose
   * music changed (up to 3; more falls back to the keepOld redraw).
   */
  edit?: boolean;
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
    const per = Math.max(1, opts.linesPerChunk ?? 2);
    const layoutKey = `${width}|${zoom}|${per}`;
    const sticky = !!opts.edit && this.layoutKey === layoutKey && this.chunks.length > 0 && this.chunks.every((c) => c.done);
    const starts = systemBreaks(score, lineBudget(width - 20 * zoom, zoom), sticky ? this.breaks : undefined);
    const specs: { from: number; to: number; lines: number }[] = [];
    for (let i = 0; i < starts.length; i += per) specs.push({ from: starts[i], to: starts[i + per] ?? score.measureCount, lines: Math.min(per, starts.length - i) });
    const draw = (c: Chunk) => {
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
      return osmd;
    };
    const xmlOf = (sp: { from: number; to: number }) => toMusicXml(score, { title: '', from: sp.from, to: sp.to, breaks: starts });

    // an edit: redraw only the chunks whose music changed
    if (sticky) {
      const xmls = specs.map(xmlOf);
      const old = new Map(this.chunks.map((c) => [`${c.from}|${c.to}`, c]));
      const changed = specs.map((sp, i) => old.get(`${sp.from}|${sp.to}`)?.xml !== xmls[i]);
      const n = changed.filter(Boolean).length;
      if (n <= 3) {
        this.staging?.remove();
        const layer = document.createElement('div');
        layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;visibility:hidden;pointer-events:none';
        layer.setAttribute('aria-hidden', 'true');
        this.host.appendChild(layer);
        this.staging = layer;
        const boxes: (MeasureBox | undefined)[] = new Array(score.measureCount);
        const chunks: Chunk[] = [];
        const index = writtenIndex(score);
        for (let i = 0; i < specs.length; i++) {
          const sp = specs[i];
          const prev = old.get(`${sp.from}|${sp.to}`);
          if (!changed[i] && prev) {
            // same music: keep the drawing; ids and times come from the new score
            for (const h of prev.hits) {
              h.ids = index.byKey.get(h.key)?.ids ?? [];
              tagHeads(h);
            }
            for (let m = sp.from; m < sp.to; m++) {
              const b = this.boxes[m];
              if (b) boxes[m] = { ...b, t0: score.measureStartTimes[m], t1: score.measureStartTimes[m + 1], entries: b.entries.map((e) => (e.pos !== undefined ? { ...e, t: score.time.posToTime(e.pos) } : e)) };
            }
            chunks.push(prev);
            continue;
          }
          const el = document.createElement('div');
          el.className = 'sheet-chunk';
          el.style.position = 'relative';
          const c: Chunk = { ...sp, el, done: false, xml: xmls[i], hits: [] };
          layer.appendChild(el);
          const osmd = draw(c);
          await osmd.load(xmls[i]);
          if (token !== this.token) return false;
          osmd.zoom = zoom;
          osmd.render();
          c.done = true;
          this.indexChunk(osmd, c, score, boxes, layer);
          chunks.push(c);
        }
        if (token !== this.token) return false;
        this.staging = null;
        layer.remove();
        this.host.replaceChildren(...chunks.map((c) => c.el));
        this.chunks = chunks;
        this.boxes = boxes;
        this.score = score;
        this.breaks = starts;
        this.lastRedrawn = n;
        this.host.dataset.redrawn = String(n);
        this.applyHighlight();
        performance.mark('sheet:edit-done');
        opts.onChunk?.(chunks.length, chunks.length);
        return true;
      }
    }

    const chunks: Chunk[] = [];
    const frag = document.createDocumentFragment();
    const estLine = this.lineHeight || 190 * zoom;
    for (const sp of specs) {
      const el = document.createElement('div');
      el.className = 'sheet-chunk';
      el.style.position = 'relative';
      el.style.minHeight = `${Math.round(estLine * sp.lines)}px`;
      chunks.push({ ...sp, el, done: false, hits: [] });
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
      this.breaks = starts;
      this.layoutKey = layoutKey;
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
      const osmd = draw(c);
      const xml = xmlOf(c);
      c.xml = xml;
      if (!done) performance.mark('sheet:first-xml');
      await osmd.load(xml);
      if (!done) performance.mark('sheet:first-loaded');
      if (token !== this.token) return false;
      osmd.zoom = zoom; // must be set after load()
      osmd.render();
      c.el.style.minHeight = '';
      c.done = true;
      this.indexChunk(osmd, c, score, boxes, layer);
      if (!staged) {
        this.copyBoxes(boxes, c);
        this.applyHighlight(c);
      }
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
      this.breaks = starts;
      this.layoutKey = layoutKey;
      this.applyHighlight();
    }
    this.lastRedrawn = chunks.length;
    this.host.dataset.redrawn = String(chunks.length);
    if (opts.edit) performance.mark('sheet:edit-done');
    return true;
  }

  /** Line starts of the music on screen (kept by edits while they fit). */
  private breaks: number[] = [];
  private layoutKey = '';
  /** Chunks drawn by the last render (an edit redraws only the changed ones). */
  lastRedrawn = 0;
  private selected = new Set<number>();
  private lit: Element[] = [];

  /** Marks the noteheads of these Song note ids as selected (every tied piece). */
  highlight(ids: Set<number>): void {
    this.selected = new Set(ids);
    this.applyHighlight();
  }

  private applyHighlight(only?: Chunk): void {
    if (!only) {
      for (const el of this.lit) el.classList.remove('sheet-sel');
      this.lit = [];
    }
    if (!this.selected.size) return;
    for (const c of only ? [only] : this.chunks)
      for (const h of c.hits)
        if (h.ids.some((id) => this.selected.has(id)))
          for (const el of h.heads) {
            el.classList.add('sheet-sel');
            this.lit.push(el);
          }
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
    this.lastZoom = osmd.zoom;
    const list = osmd.GraphicSheet?.MeasureList ?? [];
    const raw: RawHit[] = [];
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
      const entries: { t: number; x: number; pos: number }[] = [];
      const seen = new Set<number>();
      for (let si = 0; si < staves.length; si++) {
        const gm = staves[si];
        for (const se of gm?.staffEntries ?? []) {
          const rel = se.relInMeasureTimestamp?.RealValue ?? 0;
          const pos = ms + Math.round(rel * 48);
          for (const gve of se.graphicalVoiceEntries ?? []) for (const gn of gve.notes ?? []) raw.push({ gn, m, staff: si === 0 ? 1 : 2, pos });
          if (seen.has(pos)) continue;
          seen.add(pos);
          entries.push({ t: t.posToTime(pos), x: ox + se.PositionAndShape.AbsolutePosition.x * unit, pos });
        }
      }
      entries.sort((a, b) => a.t - b.t);
      const staffTop: [number, number] = [yTop, staves[1] ? oy + staves[1].PositionAndShape.AbsolutePosition.y * unit : yTop + 8 * unit];
      boxes[m] = { measure: m, t0: score.measureStartTimes[m], t1: score.measureStartTimes[m + 1], x, w, top: yTop, bottom: yBot, entries, staffTop, gap: unit };
    }
    c.hits = this.matchHits(raw, score, ox, c.el.getBoundingClientRect().top, hostRect.left + layer.clientLeft);
  }

  /** Matches OSMD's drawn notes to the written notes (writtenIndex keys) and reads their boxes. */
  private matchHits(raw: RawHit[], score: Score, ox: number, chunkTop: number, hostLeft: number): NoteHit[] {
    const index = writtenIndex(score).byKey;
    type Cand = { r: RawHit; voice: number; half: number; heads: Element[] };
    const cands: Cand[] = [];
    for (const r of raw) {
      const sn = r.gn.sourceNote as unknown as { isRest?: () => boolean; halfTone?: number; ParentVoiceEntry?: { ParentVoice?: { VoiceId?: number } } } | undefined;
      if (!sn || sn.isRest?.() || typeof sn.halfTone !== 'number') continue;
      const g = r.gn as unknown as { getNoteheadSVGs?: () => Element[]; getSVGGElement?: () => Element };
      let heads: Element[] = [];
      try {
        heads = g.getNoteheadSVGs?.()?.filter(Boolean) ?? [];
        if (!heads.length && g.getSVGGElement) heads = [g.getSVGGElement()].filter(Boolean);
      } catch {
        heads = [];
      }
      cands.push({ r, voice: sn.ParentVoiceEntry?.ParentVoice?.VoiceId ?? 0, half: sn.halfTone, heads });
    }
    // OSMD's half-tone numbering: MIDI = halfTone + 12 (checked against the written notes)
    let offset = 12;
    let bestN = -1;
    for (const off of [12, 0, 24, -12, 48]) {
      let n = 0;
      for (const c of cands) if (index.has(writtenKey(c.r.m, c.voice, c.r.pos, c.half + off))) n++;
      if (n > bestN) [bestN, offset] = [n, off];
      if (n === cands.length) break;
    }
    const out: NoteHit[] = [];
    for (const c of cands) {
      const midi = c.half + offset;
      let key = writtenKey(c.r.m, c.voice, c.r.pos, midi);
      if (!index.has(key)) {
        // an octave mark, or a voice numbered differently: the same place on the same staff
        const alt = [midi + 12, midi - 12].map((x) => writtenKey(c.r.m, c.voice, c.r.pos, x)).find((k) => index.has(k));
        const any = alt ?? [...(c.r.staff === 1 ? [1, 2] : [5, 6])].flatMap((v) => [midi, midi + 12, midi - 12].map((x) => writtenKey(c.r.m, v, c.r.pos, x))).find((k) => index.has(k));
        key = any ?? '';
      }
      const w = key ? index.get(key) : undefined;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const el of c.heads) {
        const rc = (el as Element).getBoundingClientRect?.();
        if (!rc || (!rc.width && !rc.height)) continue;
        x0 = Math.min(x0, rc.left - hostLeft);
        x1 = Math.max(x1, rc.right - hostLeft);
        y0 = Math.min(y0, rc.top - chunkTop);
        y1 = Math.max(y1, rc.bottom - chunkTop);
      }
      if (!Number.isFinite(x0)) {
        const ps = (c.r.gn as unknown as { PositionAndShape?: { AbsolutePosition: { x: number; y: number } } }).PositionAndShape;
        if (!ps) continue;
        const unit = 10 * this.zoomOf();
        x0 = ox + ps.AbsolutePosition.x * unit - 6;
        x1 = x0 + 12;
        y0 = ps.AbsolutePosition.y * unit - 5;
        y1 = y0 + 10;
      }
      out.push({
        key,
        ids: w?.ids ?? [],
        measure: c.r.m,
        staff: w?.staff ?? c.r.staff,
        voice: c.voice,
        pos: c.r.pos,
        midi: w?.midi ?? midi,
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2,
        x0,
        y0,
        x1,
        y1,
        heads: c.heads,
      });
      tagHeads(out[out.length - 1]);
    }
    return out;
  }

  private zoomOf(): number {
    return this.lastZoom;
  }
  private lastZoom = 1;

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

  /** Every drawn note, in host coordinates. */
  noteHits(): NoteHit[] {
    const out: NoteHit[] = [];
    for (const c of this.chunks) {
      const dy = c.el.offsetTop;
      for (const h of c.hits) out.push({ ...h, cy: h.cy + dy, y0: h.y0 + dy, y1: h.y1 + dy });
    }
    return out;
  }

  /** Drawn pieces of a Song note (host coordinates). */
  hitsOf(id: number): NoteHit[] {
    return this.noteHits().filter((h) => h.ids.includes(id));
  }

  /**
   * The notes under a point (host coordinates), nearest first: boxes inflated by 6 px for a mouse
   * or pen, 18 px for touch; distance to the head centre with y weighted 1.5×.
   */
  notesAt(x: number, y: number, pointerType = 'mouse'): NoteHit[] {
    const pad = pointerType === 'touch' ? 18 : 6;
    const found: { h: NoteHit; d: number }[] = [];
    for (const h of this.noteHits()) {
      if (!h.ids.length) continue;
      if (x < h.x0 - pad || x > h.x1 + pad || y < h.y0 - pad || y > h.y1 + pad) continue;
      found.push({ h, d: Math.hypot(x - h.cx, (y - h.cy) * 1.5) });
    }
    return found.sort((a, b) => a.d - b.d).map((f) => f.h);
  }

  /** Measure box (host coordinates) whose line holds y and whose x range is nearest x. */
  private measureNear(x: number, y: number, slack = 0.6): MeasureBox | null {
    let best: MeasureBox | null = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (let m = 0; m < this.boxes.length; m++) {
      const b = this.box(m);
      if (!b) continue;
      const pad = (b.bottom - b.top) * slack;
      const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
      if (dy > pad) continue;
      const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
      if (dy < bestDy - 0.5 || (Math.abs(dy - bestDy) <= 0.5 && dx < bestDx)) {
        bestDy = dy;
        bestDx = dx;
        best = b;
      }
    }
    return best && bestDx <= 24 ? best : null;
  }

  /** Position (divisions, unsnapped) at x inside measure m: between the drawn entries, or across the box. */
  posAt(m: number, x: number): number | null {
    const b = this.box(m);
    const s = this.score;
    if (!b || !s) return null;
    const a = s.time.measureStart(m);
    const end = s.time.measureStart(m + 1);
    const pts = [{ pos: a, x: b.x + Math.min(24, b.w * 0.1) }, ...b.entries.filter((e) => e.pos !== undefined && e.pos > a).map((e) => ({ pos: e.pos!, x: e.x })), { pos: end, x: b.x + b.w - 6 }];
    // the first entry (often after the clef and key) stands for the measure start
    const firstEntry = b.entries.find((e) => e.pos === a);
    if (firstEntry) pts[0] = { pos: a, x: firstEntry.x };
    pts.sort((p, q) => p.pos - q.pos);
    if (x <= pts[0].x) return a;
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (x <= q.x) return q.x > p.x ? p.pos + ((x - p.x) / (q.x - p.x)) * (q.pos - p.pos) : p.pos;
    }
    return end;
  }

  /** x (host) of a position in measure m. */
  xAt(m: number, pos: number): number | null {
    const b = this.box(m);
    const s = this.score;
    if (!b || !s) return null;
    const a = s.time.measureStart(m);
    const end = s.time.measureStart(m + 1);
    const first = b.entries.find((e) => e.pos === a);
    const pts = [{ pos: a, x: first?.x ?? b.x + Math.min(24, b.w * 0.1) }, ...b.entries.filter((e) => e.pos !== undefined && e.pos > a).map((e) => ({ pos: e.pos!, x: e.x })), { pos: end, x: b.x + b.w - 6 }];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (pos <= q.pos) return q.pos > p.pos ? p.x + ((pos - p.pos) / (q.pos - p.pos)) * (q.x - p.x) : p.x;
    }
    return pts[pts.length - 1].x;
  }

  /** Where a new note at (x, y) would go: measure, staff, snapped position and pitch. */
  slotAt(x: number, y: number): SheetSlot | null {
    const s = this.score;
    const b = this.measureNear(x, y);
    if (!s || !b || !b.staffTop || !b.gap) return null;
    const dy = this.chunkOf(b.measure)?.el.offsetTop ?? 0;
    const gap = b.gap;
    const tops = [b.staffTop[0] + dy, b.staffTop[1] + dy];
    // the nearer staff (each extended 4 gaps for ledger lines)
    const dist = (top: number) => (y < top ? top - y : y > top + 4 * gap ? y - (top + 4 * gap) : 0);
    const staff: Staff = dist(tops[1]) < dist(tops[0]) ? 2 : 1;
    const top = tops[staff - 1];
    if (dist(top) > 6 * gap) return null;
    const m = b.measure;
    const raw = this.posAt(m, x);
    if (raw === null) return null;
    const a = s.time.measureStart(m);
    const end = s.time.measureStart(m + 1);
    let pos = snapPos(s, raw, 'floor');
    if (raw - pos > (snapPos(s, raw, 'ceil') - raw) && snapPos(s, raw, 'ceil') < end) pos = snapPos(s, raw, 'ceil');
    pos = Math.max(a, Math.min(pos, end - 1));
    if (snapPos(s, pos, 'floor') !== pos) pos = snapPos(s, pos, 'floor');
    const clef = s.clefs[staff - 1][Math.min(m, s.clefs[staff - 1].length - 1)] ?? (staff === 1 ? 'G' : 'F');
    const ott = ottavaAt(s, staff, pos);
    const dn = diatonicAtY(y, top, gap, clef, ott);
    const midi = Math.max(21, Math.min(108, diatonicToMidi(dn, alterAt(s, staff, m, pos, dn))));
    return { measure: m, staff, pos, midi, dn, x: this.xAt(m, pos) ?? x, y: yOfDiatonic(dn, top, gap, clef, ott), staffTop: top, gap };
  }

  /** Song note ids whose noteheads lie inside a rectangle (host coordinates). */
  marquee(x0: number, y0: number, x1: number, y1: number): number[] {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const out = new Set<number>();
    for (const h of this.noteHits()) if (h.cx >= ax && h.cx <= bx && h.cy >= ay && h.cy <= by) for (const id of h.ids) out.add(id);
    return [...out];
  }

  /** The Score drawn on screen. */
  get drawnScore(): Score | null {
    return this.score;
  }

  /** Top (content px) of the line holding measure m, for scrolling. */
  lineTopOf(m: number): number | null {
    const b = this.box(m);
    if (b) return b.top;
    const c = this.chunkOf(m);
    return c ? c.el.offsetTop : null;
  }
}
