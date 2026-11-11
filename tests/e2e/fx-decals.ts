// Dev-only visual harness for note decals (src/lib/render/decals.ts).
//   /tests/e2e/fx-decals.html?mode=gallery          all tiles, each tiled 2×2
//   /tests/e2e/fx-decals.html?mode=seam&id=meadow   one tile 2×2 at full resolution
//   /tests/e2e/fx-decals.html?mode=scene&h=1080     mock 1920×1080 piano roll (h scales it)
//   /tests/e2e/fx-decals.html?mode=perf             150 decal notes × 60 frames timing
import { DECAL_PATTERNS, getPatternTile, paintNoteDecal } from '../../src/lib/render/decals';
import { BLACK_RGB, WHITE, hash, hexToRgb, mix, rgba, roundRect, type Ctx2D, type RGB } from '../../src/lib/render/color';
import type { DecalSettings } from '../../src/lib/render/settings';

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
    const w = (black ? keyW * 0.58 : keyW * 0.86) * (W / 1920) * (1920 / W);
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

function drawNotes(ctx: Ctx2D, notes: MockNote[], sc: number, timing?: { t: number }) {
  for (const n of notes) {
    const tile = getPatternTile(n.settings.patternId)!;
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
  if (q.get('cm')) (globalThis as unknown as { __cm?: string }).__cm = q.get('cm')!;
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
  if (q.get('cm')) (globalThis as unknown as { __cm?: string }).__cm = q.get('cm')!;
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

try {
  if (mode === 'gallery') gallery();
  else if (mode === 'seam') seam();
  else if (mode === 'scene') scene();
  else if (mode === 'perf') perf();
  else if (mode === 'tints' || mode === 'micro') throw new Error('skip');
  if (mode !== 'perf') log.textContent = 'ready';
  document.body.dataset.done = '1';
} catch (e) {
  log.textContent = 'ERROR ' + (e as Error).stack;
  document.body.dataset.done = '1';
}

// tint comparison: rows = colours, columns = tint 0..1
if (mode === 'tints') {
  (globalThis as unknown as { __tm?: string }).__tm = q.get('tm') ?? undefined;
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
  log.textContent = 'ready';
  document.body.dataset.done = '1';
}

// micro-benchmark of fill strategies (dev only)
if (mode === 'micro') {
  const sw = q.get('sw') === '1';
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  document.body.appendChild(c);
  const ctx = c.getContext('2d', sw ? { willReadFrequently: true } : undefined)!;
  const notes = buildScene(1920, 1080, 1, 150, [{}]);
  const tile = getPatternTile('meadow')!;
  const small = document.createElement('canvas');
  small.width = 300;
  small.height = 300;
  small.getContext('2d')!.drawImage(tile, 0, 0, 300, 300);
  const pat = ctx.createPattern(small, 'repeat')!;
  const res: Record<string, number> = {};
  const run = (name: string, fn: (n: MockNote, f: number) => void) => {
    for (let f = 0; f < 5; f++) for (const n of notes) fn(n, f);
    ctx.getImageData(0, 0, 1, 1);
    const t0 = performance.now();
    for (let f = 0; f < 60; f++) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1920, 1080);
      for (const n of notes) fn(n, f);
    }
    ctx.getImageData(0, 0, 1, 1);
    res[name] = +((performance.now() - t0) / 60).toFixed(2);
  };
  run('clearOnly', () => {});
  run('solid', (n) => {
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = '#88f';
    ctx.fill();
  });
  run('solidRect', (n) => {
    ctx.fillStyle = '#88f';
    ctx.fillRect(n.x, n.y, n.w, n.h);
  });
  run('patFrac', (n, f) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: n.x + 0.37, f: n.y + f * 0.3 });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = pat;
    ctx.fill();
  });
  run('patInt', (n) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = pat;
    ctx.fill();
  });
  run('patIntRect', (n) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.fillStyle = pat;
    ctx.fillRect(n.x, n.y, n.w, n.h);
  });
  run('drawImageClip', (n) => {
    ctx.save();
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.clip();
    ctx.drawImage(small, 0, 0, Math.min(300, n.w), Math.min(300, n.h), n.x, n.y, Math.min(300, n.w), Math.min(300, n.h));
    ctx.restore();
  });
  run('drawImageNoClip', (n) => {
    ctx.drawImage(small, 0, 0, Math.min(300, n.w), Math.min(300, n.h), Math.round(n.x), Math.round(n.y), Math.min(300, n.w), Math.min(300, n.h));
  });
  run('patIntAlpha', (n) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = pat;
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  run('patIntSave', (n) => {
    ctx.save();
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = pat;
    ctx.fill();
    ctx.restore();
  });
  const pats = ['meadow', 'sakura', 'galaxy'].map((id) => {
    const cc = document.createElement('canvas');
    cc.width = 300;
    cc.height = 300;
    cc.getContext('2d')!.drawImage(getPatternTile(id)!, 0, 0, 300, 300);
    return ctx.createPattern(cc, 'repeat')!;
  });
  run('pat3', (n) => {
    const pt = pats[n.id % 3];
    pt.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = pt;
    ctx.fill();
  });
  const trans = document.createElement('canvas');
  trans.width = 300;
  trans.height = 300;
  const tc = trans.getContext('2d')!;
  tc.globalAlpha = 0.95;
  tc.drawImage(small, 0, 0);
  const patT = ctx.createPattern(trans, 'repeat')!;
  run('patTranslucent', (n) => {
    patT.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = patT;
    ctx.fill();
  });
  run('patIntAlphaRect', (n) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = pat;
    ctx.fillRect(n.x, n.y, n.w, n.h);
    ctx.globalAlpha = 1;
  });
  run('realDecal', (n) => {
    ctx.globalAlpha = 0.95;
    paintNoteDecal(ctx, n, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: n.settings, color: n.color, noteId: n.id, anchorY: n.y + n.h, scale: 1, active: false });
    ctx.globalAlpha = 1;
  });
  run('solidThenDecal', (n) => {
    ctx.globalAlpha = 0.95;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = '#88f';
    ctx.fill();
    paintNoteDecal(ctx, n, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: n.settings, color: n.color, noteId: n.id, anchorY: n.y + n.h, scale: 1, active: false });
    ctx.globalAlpha = 1;
  });
  run('gradOnly', (n) => {
    ctx.globalAlpha = 0.95;
    const g = ctx.createLinearGradient(0, n.y, 0, n.y + n.h);
    g.addColorStop(0, '#99f');
    g.addColorStop(1, '#559');
    ctx.fillStyle = g;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  run('gradThenDecal', (n) => {
    ctx.globalAlpha = 0.95;
    const g = ctx.createLinearGradient(0, n.y, 0, n.y + n.h);
    g.addColorStop(0, '#99f');
    g.addColorStop(1, '#559');
    ctx.fillStyle = g;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    paintNoteDecal(ctx, n, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: n.settings, color: n.color, noteId: n.id, anchorY: n.y + n.h, scale: 1, active: false });
    ctx.globalAlpha = 1;
  });
  run('gradThenPatInt', (n) => {
    ctx.globalAlpha = 0.95;
    const g = ctx.createLinearGradient(0, n.y, 0, n.y + n.h);
    g.addColorStop(0, '#99f');
    g.addColorStop(1, '#559');
    ctx.fillStyle = g;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.fillStyle = pat;
    ctx.fill();
  });
  const g1 = ctx.createLinearGradient(0, 0, 0, 1080);
  g1.addColorStop(0, '#99f');
  g1.addColorStop(1, '#559');
  run('sharedGradThenPatInt', (n) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.fillStyle = pat;
    ctx.fill();
  });
  run('solidThenPatInt', (n) => {
    ctx.fillStyle = '#88f';
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.fillStyle = pat;
    ctx.fill();
  });
  run('solidThenSolid', (n) => {
    ctx.fillStyle = '#88f';
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.fillStyle = '#f8a';
    ctx.fill();
  });
  run('patThenPat', (n) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = pat;
    ctx.fill();
    ctx.fill();
  });
  run('patThenPatTiny', (n) => {
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, 6, 6, 2);
    ctx.fillStyle = pat;
    ctx.fill();
    ctx.fill();
  });
  run('patIntOtherCtxPat', (n) => {
    // same op count as patThenPat but the 2nd fill is offset (no overdraw)
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w / 2, n.h, 6);
    ctx.fillStyle = pat;
    ctx.fill();
    roundRect(ctx, n.x + n.w / 2, n.y, n.w / 2, n.h, 6);
    ctx.fill();
  });
  run('gradThenDrawImage', (n) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.drawImage(small, 0, 0, Math.min(300, n.w), Math.min(300, n.h), Math.round(n.x), Math.round(n.y), Math.min(300, n.w), Math.min(300, n.h));
  });
  run('drawImageTwice', (n) => {
    ctx.drawImage(small, 0, 0, Math.min(300, n.w), Math.min(300, n.h), Math.round(n.x), Math.round(n.y), Math.min(300, n.w), Math.min(300, n.h));
    ctx.drawImage(small, 0, 0, Math.min(300, n.w), Math.min(300, n.h), Math.round(n.x), Math.round(n.y), Math.min(300, n.w), Math.min(300, n.h));
  });
  run('gradRectThenPatRect', (n) => {
    ctx.fillStyle = g1;
    ctx.fillRect(n.x, n.y, n.w, n.h);
    pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.fillStyle = pat;
    ctx.fillRect(Math.round(n.x), Math.round(n.y), Math.round(n.w), Math.round(n.h));
  });
  const oc = new OffscreenCanvas(300, 300);
  oc.getContext('2d')!.drawImage(small, 0, 0);
  const bmp = oc.transferToImageBitmap();
  const patB = ctx.createPattern(bmp, 'repeat')!;
  run('gradThenPatBitmap', (n) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    patB.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    ctx.fillStyle = patB;
    ctx.fill();
  });
  run('patThenPatBitmap', (n) => {
    patB.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = patB;
    ctx.fill();
    ctx.fill();
  });
  const padded = document.createElement('canvas');
  padded.width = 600;
  padded.height = 600;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) padded.getContext('2d')!.drawImage(small, a * 300, b * 300);
  const patNR = ctx.createPattern(padded, 'no-repeat')!;
  const capGrad = (n: MockNote) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.drawImage(padded, 10, 10, n.w, n.h - 12, n.x, n.y + 6, n.w, n.h - 12);
  };
  const capPath = (n: MockNote, top: boolean) => {
    ctx.beginPath();
    const y0 = top ? n.y : n.y + n.h - 6;
    ctx.rect(n.x, y0, n.w, 6);
  };
  run('capsPatRepeat300', (n) => {
    capGrad(n);
    for (const top of [true, false]) {
      capPath(n, top);
      pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(n.y) });
      ctx.fillStyle = pat;
      ctx.fill();
    }
  });
  run('capsPatNoRepeat600', (n) => {
    capGrad(n);
    for (const top of [true, false]) {
      capPath(n, top);
      patNR.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x) - 10, f: Math.round(n.y) - 10 });
      ctx.fillStyle = patNR;
      ctx.fill();
    }
  });
  run('capsClipDraw', (n) => {
    capGrad(n);
    for (const top of [true, false]) {
      ctx.save();
      capPath(n, top);
      ctx.clip();
      ctx.drawImage(padded, 10, 10, n.w, 6, n.x, top ? n.y : n.y + n.h - 6, n.w, 6);
      ctx.restore();
    }
  });
  run('capsDrawOnly', (n) => {
    capGrad(n);
    for (const top of [true, false]) ctx.drawImage(padded, 10, 10, n.w, 6, n.x, top ? n.y : n.y + n.h - 6, n.w, 6);
  });
  run('capsRows', (n) => {
    capGrad(n);
    for (const top of [true, false]) for (let i = 0; i < 6; i++) ctx.drawImage(padded, 10 + i, 10 + i, n.w - 2 * i, 1, n.x + i, (top ? n.y : n.y + n.h - 6) + i, n.w - 2 * i, 1);
  });
  run('noCaps', (n) => capGrad(n));
  const tinyC = document.createElement('canvas');
  tinyC.width = 96;
  tinyC.height = 16;
  tinyC.getContext('2d')!.drawImage(padded, 0, 0);
  const patTiny = ctx.createPattern(tinyC, 'no-repeat')!;
  run('capsTinySrc', (n) => {
    capGrad(n);
    for (const top of [true, false]) {
      capPath(n, top);
      patTiny.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x), f: Math.round(top ? n.y : n.y + n.h - 6) });
      ctx.fillStyle = patTiny;
      ctx.fill();
    }
  });
  run('capsSolid', (n) => {
    capGrad(n);
    for (const top of [true, false]) {
      capPath(n, top);
      ctx.fillStyle = '#8af';
      ctx.fill();
    }
  });
  const poc = new OffscreenCanvas(600, 600);
  poc.getContext('2d')!.drawImage(padded, 0, 0);
  const pbmp = poc.transferToImageBitmap();
  run('noCapsBitmap', (n) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.drawImage(pbmp, 10, 10, n.w, n.h - 12, n.x, n.y + 6, n.w, n.h - 12);
  });
  const poc2 = new OffscreenCanvas(600, 600);
  poc2.getContext('2d')!.drawImage(padded, 0, 0);
  run('noCapsOffscreen', (n) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.drawImage(poc2, 10, 10, n.w, n.h - 12, n.x, n.y + 6, n.w, n.h - 12);
  });
  const patBmpNR = ctx.createPattern(pbmp, 'no-repeat')!;
  run('capsBitmapPat', (n) => {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = g1;
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.drawImage(pbmp, 10, 10, n.w, n.h - 12, n.x, n.y + 6, n.w, n.h - 12);
    for (const top of [true, false]) {
      capPath(n, top);
      patBmpNR.setTransform({ a: 1, b: 0, c: 0, d: 1, e: Math.round(n.x) - 10, f: Math.round(n.y) - 10 });
      ctx.fillStyle = patBmpNR;
      ctx.fill();
    }
  });
  run('multiplyFill', (n) => {
    ctx.globalCompositeOperation = 'multiply';
    roundRect(ctx, n.x, n.y, n.w, n.h, 6);
    ctx.fillStyle = '#8af';
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  });
  log.textContent = JSON.stringify(res);
  document.body.dataset.done = '1';
}
