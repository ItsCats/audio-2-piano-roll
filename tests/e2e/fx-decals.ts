// Dev-only visual harness for note decals (src/lib/render/decals.ts).
//   /tests/e2e/fx-decals.html?mode=gallery          all tiles, each tiled 2×2
//   /tests/e2e/fx-decals.html?mode=seam&id=meadow   one tile 2×2 at full resolution
//   /tests/e2e/fx-decals.html?mode=scene&h=1080&groups=meadow,sakura:note:0.3,galaxy:screen
//        mock 16:9 piano roll; groups = patternId[:anchor[:tint[:opacity[:scale]]]] ('photo' = fake user image)
//   /tests/e2e/fx-decals.html?mode=tints&id=meadow  tint ramp 0..1 over five note colours
//   /tests/e2e/fx-decals.html?mode=real&id=meadow   the real PianoRollRenderer with a decal
//   /tests/e2e/fx-decals.html?mode=perf             150 decal notes at 1920×1080: decal cost per frame
//        (&nostroke=1 drops the glow outline, &tint=x, &alpha=x, &one=1 single pattern)
//   /tests/e2e/fx-decals.html?mode=notebench        per-note cost breakdown (clip / copy / fill / pattern fill)
import { DECAL_PATTERNS, getPatternTile, paintNoteDecal } from '../../src/lib/render/decals';
import { BLACK_RGB, WHITE, hash, hexToRgb, mix, rgba, roundRect, type Ctx2D, type RGB } from '../../src/lib/render/color';
import { DEFAULT_VISUAL, type DecalSettings, type VisualSettings } from '../../src/lib/render/settings';
import { PianoRollRenderer } from '../../src/lib/render/renderer';
import { bachPreludeDemo } from '../../src/lib/music/demo';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'gallery';
const log = document.getElementById('log')!;

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  return c.getContext('2d')!;
}

function gallery() {
  const cell = 300;
  const cols = 5;
  const rows = Math.ceil(DECAL_PATTERNS.length / cols);
  const ctx = canvas(cols * cell, rows * (cell + 24));
  ctx.fillStyle = '#0b0b10';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  DECAL_PATTERNS.forEach((p, i) => {
    const t0 = performance.now();
    const tile = getPatternTile(p.id)!;
    const ms = performance.now() - t0;
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * (cell + 24);
    const half = (cell - 12) / 2;
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) ctx.drawImage(tile, x + 6 + dx * half, y + 6 + dy * half, half, half);
    ctx.fillStyle = '#ddd';
    ctx.font = '13px system-ui';
    ctx.fillText(`${p.id}  (${ms.toFixed(0)} ms)`, x + 8, y + cell + 12);
  });
}

function seam() {
  const id = q.get('id') ?? 'meadow';
  const tile = getPatternTile(id)!;
  const ctx = canvas(1024, 1024);
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) ctx.drawImage(tile, dx * 512, dy * 512);
}

interface MockNote {
  id: number;
  x: number;
  w: number;
  y: number;
  h: number;
  color: RGB;
  active: boolean;
  settings: DecalSettings;
}

const NOTE_ALPHA = Number(q.get('alpha') ?? 0.95);
const base: DecalSettings = { source: 'pattern', patternId: 'meadow', mediaId: null, scale: 1, opacity: 1, tint: 0.15, anchor: 'note' };

function buildScene(W: number, H: number, sc: number, count: number, groups: Partial<DecalSettings>[]): MockNote[] {
  const kbTop = H * 0.84;
  const keyW = W / 52;
  const notes: MockNote[] = [];
  const right = hexToRgb('#4f9dff');
  const left = hexToRgb('#f5a524');
  for (let i = 0; i < count; i++) {
    const g = groups[Math.floor((i / count) * groups.length)];
    const key = Math.floor(hash(i, 1) * 50) + 1;
    const black = hash(i, 2) < 0.3;
    const w = black ? keyW * 0.58 : keyW * 0.86;
    const x = key * keyW + (black ? keyW * 0.7 : (keyW - w) / 2);
    const h = (30 + hash(i, 3) * 260) * sc;
    const bottom = kbTop - hash(i, 4) * (kbTop - 60 * sc) * 0.95;
    const active = bottom > kbTop - 30 * sc;
    notes.push({
      id: i * 7 + 3,
      x,
      w,
      y: active ? kbTop - h : bottom - h,
      h,
      color: key < 26 ? left : right,
      active,
      settings: { ...base, ...g },
    });
  }
  return notes;
}

let photo: HTMLCanvasElement | null = null;
/** stand-in for a user-uploaded (non-tiling) photo: 1600×1000 sunset with a sun disc */
function fakePhoto(): HTMLCanvasElement {
  if (photo) return photo;
  photo = document.createElement('canvas');
  photo.width = 1600;
  photo.height = 1000;
  const c = photo.getContext('2d')!;
  const g = c.createLinearGradient(0, 0, 0, 1000);
  g.addColorStop(0, '#2b4c9b');
  g.addColorStop(0.55, '#f08a5d');
  g.addColorStop(1, '#ffd36e');
  c.fillStyle = g;
  c.fillRect(0, 0, 1600, 1000);
  c.fillStyle = '#fff3c4';
  c.beginPath();
  c.arc(800, 640, 160, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#1d2240';
  c.fillRect(0, 760, 1600, 240);
  return photo;
}

function drawNotes(ctx: Ctx2D, notes: MockNote[], sc: number, timing?: { t: number }) {
  for (const n of notes) {
    const tile = n.settings.patternId === 'photo' ? fakePhoto() : getPatternTile(n.settings.patternId)!;
    const r = { x: n.x, y: n.y, w: n.w, h: n.h };
    const radius = 6 * sc;
    const c = n.active ? mix(n.color, WHITE, 0.25) : n.color;
    ctx.globalAlpha = NOTE_ALPHA;
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, rgba(mix(c, WHITE, 0.22), 1));
    g.addColorStop(1, rgba(mix(c, BLACK_RGB, 0.12), 1));
    ctx.fillStyle = g;
    roundRect(ctx, r.x, r.y, r.w, r.h, radius);
    ctx.fill();
    const t0 = timing ? performance.now() : 0;
    paintNoteDecal(ctx, r, radius, {
      image: tile,
      imageWidth: tile.width,
      imageHeight: tile.height,
      settings: n.settings,
      color: c,
      noteId: n.id,
      anchorY: r.y + r.h,
      scale: sc,
      active: n.active,
    });
    if (timing) timing.t += performance.now() - t0;
    if (ctx.globalAlpha !== NOTE_ALPHA) throw new Error('globalAlpha not restored');
    if (q.get('nostroke')) continue;
    roundRect(ctx, r.x, r.y, r.w, r.h, radius);
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 10 * sc * (n.active ? 1.6 : 1);
    ctx.lineWidth = Math.max(1, 1.8 * sc);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function background(ctx: Ctx2D, W: number, H: number, sc: number) {
  ctx.fillStyle = '#07070a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let i = 1; i < 8; i++) ctx.fillRect(Math.round((i * W) / 7.5), 0, Math.max(1, sc), H * 0.84);
  const kbTop = H * 0.84;
  const keyW = W / 52;
  ctx.fillStyle = '#ecebe6';
  ctx.fillRect(0, kbTop, W, H - kbTop);
  ctx.fillStyle = '#1b1b20';
  for (let i = 0; i < 52; i++) ctx.fillRect(i * keyW, kbTop, Math.max(1, sc), H - kbTop);
  for (let i = 0; i < 52; i++) if ([0, 1, 3, 4, 5].includes(i % 7)) ctx.fillRect(i * keyW + keyW * 0.68, kbTop, keyW * 0.62, (H - kbTop) * 0.62);
}

function scene() {
  const H = Number(q.get('h') ?? 1080);
  const W = Math.round((H * 16) / 9);
  const sc = H / 1080;
  const ctx = canvas(W, H);
  background(ctx, W, H, sc);
  const groups: Partial<DecalSettings>[] = (q.get('groups') ?? '')
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const [patternId, anchor, tint, opacity, scale] = s.split(':');
      return {
        patternId,
        anchor: (anchor as 'note' | 'screen') || 'note',
        tint: tint ? Number(tint) : 0.15,
        opacity: opacity ? Number(opacity) : 1,
        scale: scale ? Number(scale) : 1,
      };
    });
  const notes = buildScene(W, H, sc, Number(q.get('n') ?? 40), groups.length ? groups : [{}]);
  drawNotes(ctx, notes, sc);
}

function perf() {
  // 150 decal notes at 1920×1080 drawn the way the renderer draws a note (gradient fill →
  // decal → glowing outline). Decal cost = frame time with decals − frame time without,
  // measured in alternating blocks; medians reported to tame software-raster noise.
  const W = 1920;
  const H = 1080;
  const ctx = canvas(W, H);
  const tintQ = q.get('tint');
  const groups: Partial<DecalSettings>[] = (q.get('one') ? [{ patternId: 'meadow' }] : [{ patternId: 'meadow' }, { patternId: 'sakura', tint: 0.4 }, { patternId: 'galaxy', anchor: 'screen' as const }]).map((g) =>
    tintQ !== null ? { ...g, tint: Number(tintQ) } : g,
  );
  const notes = buildScene(W, H, 1, 150, groups);
  const on = notes.map((n) => n.settings);
  const off = on.map((st) => ({ ...st, opacity: 0 }));
  let frame = 0;
  const block = (withDecals: boolean, frames: number, timing?: { t: number }) => {
    notes.forEach((n, i) => (n.settings = withDecals ? on[i] : off[i]));
    ctx.getImageData(0, 0, 1, 1);
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      background(ctx, W, H, 1);
      for (const n of notes) n.y = n.y - 2 < -400 ? 1000 : n.y - 2;
      drawNotes(ctx, notes, 1, timing);
      frame++;
    }
    ctx.getImageData(0, 0, 1, 1);
    return (performance.now() - t0) / frames;
  };
  block(true, 20);
  block(false, 20);
  const a: number[] = [];
  const b: number[] = [];
  const timing = { t: 0 };
  for (let r = 0; r < 8; r++) {
    a.push(block(true, 30, timing));
    b.push(block(false, 30));
  }
  const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
  log.textContent = JSON.stringify({
    frames: frame,
    withDecalsMs: +med(a).toFixed(2),
    withoutDecalsMs: +med(b).toFixed(2),
    decalCostMsPerFrame: +(med(a) - med(b)).toFixed(2),
    insideDecalCallsMs: +(timing.t / 240).toFixed(2),
  });
}

/** The real renderer with a decal (other effects as configured by the app defaults). */
function real() {
  const H = Number(q.get('h') ?? 1080);
  const W = Math.round((H * 16) / 9);
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  const vs: VisualSettings = {
    ...DEFAULT_VISUAL,
    range: (q.get('range') as VisualSettings['range']) ?? 'auto',
    cornerRadius: 6,
    decal: { ...DEFAULT_VISUAL.decal, source: 'pattern', patternId: q.get('id') ?? 'meadow', tint: Number(q.get('tint') ?? 0.15), anchor: (q.get('anchor') as 'note' | 'screen') ?? 'note' },
    effects: { ...DEFAULT_VISUAL.effects, outlineGlow: 0.6 },
  };
  const r = new PianoRollRenderer(c, vs);
  r.resize(W, H);
  const demo = bachPreludeDemo();
  r.setNotes(demo.notes, demo.pedal, demo.tempo);
  r.render({ time: Number(q.get('t') ?? 6.3) });
}

/** Tint comparison: rows = note colours, columns = tint 0, 0.2 … 1. */
function tints() {
  const ctx = canvas(1200, 700);
  ctx.fillStyle = '#07070a';
  ctx.fillRect(0, 0, 1200, 700);
  const cols = ['#f5a524', '#4f9dff', '#3ddc84', '#ff5fa2', '#8b7cff'].map(hexToRgb);
  const pat = q.get('id') ?? 'meadow';
  const tile = getPatternTile(pat)!;
  cols.forEach((c, row) => {
    for (let i = 0; i < 6; i++) {
      const tint = i / 5;
      for (let j = 0; j < 4; j++) {
        const r = { x: 20 + i * 195 + j * 44, y: 20 + row * 135, w: 34, h: 120 };
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = rgba(c, 1);
        roundRect(ctx, r.x, r.y, r.w, r.h, 6);
        ctx.fill();
        paintNoteDecal(ctx, r, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: { ...base, patternId: pat, tint }, color: c, noteId: j * 13 + row, anchorY: r.y + r.h, scale: 1, active: false });
      }
    }
  });
  ctx.globalAlpha = 1;
}

/** Per-note overhead breakdown: 170 small (30×60) notes, what each piece costs per frame. */
function notebench() {
  const W = 1920;
  const H = 1080;
  const ctx = canvas(W, H);
  ctx.fillStyle = '#123';
  ctx.fillRect(0, 0, W, H);
  const mk = (alpha: number) => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 600;
    const g = c.getContext('2d')!;
    g.globalAlpha = alpha;
    g.drawImage(getPatternTile('meadow')!, 0, 0, 600, 600);
    return c;
  };
  const opaque = mk(1);
  const translucent = mk(0.7);
  const pat = ctx.createPattern(translucent, 'repeat')!;
  const rects: { x: number; y: number }[] = [];
  for (let i = 0; i < 170; i++) rects.push({ x: 20.3 + (i % 34) * 55.7, y: 30.6 + Math.floor(i / 34) * 180.2 });
  const variants: Record<string, (x: number, y: number) => void> = {
    clipDrawOpaque: (x, y) => {
      ctx.save();
      roundRect(ctx, x, y, 30, 60, 6);
      ctx.clip();
      ctx.drawImage(opaque, 10, 10, 31, 61, Math.floor(x), Math.floor(y), 31, 61);
      ctx.restore();
    },
    clipDrawTranslucent: (x, y) => {
      ctx.save();
      roundRect(ctx, x, y, 30, 60, 6);
      ctx.clip();
      ctx.drawImage(translucent, 10, 10, 31, 61, Math.floor(x), Math.floor(y), 31, 61);
      ctx.restore();
    },
    drawOnly: (x, y) => ctx.drawImage(translucent, 10, 10, 31, 61, Math.floor(x), Math.floor(y), 31, 61),
    clipOnly: (x, y) => {
      ctx.save();
      roundRect(ctx, x, y, 30, 60, 6);
      ctx.clip();
      ctx.restore();
    },
    fillOnly: (x, y) => {
      ctx.fillStyle = '#f0c';
      roundRect(ctx, x, y, 30, 60, 6);
      ctx.fill();
    },
    patternFill: (x, y) => {
      pat.setTransform(new DOMMatrix([1, 0, 0, 1, Math.round(x) - 10, Math.round(y) - 10]));
      ctx.fillStyle = pat;
      roundRect(ctx, x, y, 30, 60, 6);
      ctx.fill();
    },
    patternFillNoSmooth: (x, y) => {
      ctx.imageSmoothingEnabled = false;
      pat.setTransform(new DOMMatrix([1, 0, 0, 1, Math.round(x) - 10, Math.round(y) - 10]));
      ctx.fillStyle = pat;
      roundRect(ctx, x, y, 30, 60, 6);
      ctx.fill();
      ctx.imageSmoothingEnabled = true;
    },
    real: (x, y) =>
      paintNoteDecal(ctx, { x, y, w: 30, h: 60 }, 6, { image: getPatternTile('meadow')!, imageWidth: 512, imageHeight: 512, settings: { ...DEFAULT_VISUAL.decal, patternId: 'meadow', tint: 0.15 }, color: WHITE, noteId: Math.round(x), anchorY: y + 60, scale: 1, active: false }),
  };
  const res: Record<string, number[]> = {};
  for (let k = 0; k < 5; k++)
    for (const [name, fn] of Object.entries(variants)) {
      ctx.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      for (let f = 0; f < 20; f++) for (const r of rects) fn(r.x, r.y);
      ctx.getImageData(0, 0, 1, 1);
      (res[name] ??= []).push(+((performance.now() - t0) / 20).toFixed(2));
    }
  log.textContent = JSON.stringify(res);
}

try {
  if (mode === 'gallery') gallery();
  else if (mode === 'real') real();
  else if (mode === 'seam') seam();
  else if (mode === 'scene') scene();
  else if (mode === 'perf') perf();
  else if (mode === 'tints') tints();
  else if (mode === 'notebench') notebench();
  if (mode !== 'perf' && mode !== 'notebench') log.textContent = 'ready';
  document.body.dataset.done = '1';
} catch (e) {
  log.textContent = 'ERROR ' + (e as Error).stack;
  document.body.dataset.done = '1';
}
