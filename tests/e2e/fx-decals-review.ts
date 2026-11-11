// Review harness for src/lib/render/decals.ts (dev only).
import { DECAL_PATTERNS, getPatternTile, paintNoteDecal } from '../../src/lib/render/decals';
import { hexToRgb, type Ctx2D } from '../../src/lib/render/color';
import { DEFAULT_VISUAL, type VisualSettings, type DecalSettings } from '../../src/lib/render/settings';
import { PianoRollRenderer } from '../../src/lib/render/renderer';
import { bachPreludeDemo } from '../../src/lib/music/demo';
import type { Note } from '../../src/lib/music/types';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'real';
const log = document.getElementById('log')!;
const out: Record<string, unknown> = {};

function notesFor(kind: string): Note[] {
  if (kind === 'demo') return bachPreludeDemo().notes;
  const notes: Note[] = [];
  let id = 1;
  const add = (midi: number, start: number, dur: number, hand: 'L' | 'R' = midi < 60 ? 'L' : 'R') =>
    notes.push({ id: id++, midi, start, dur, vel: 0.6, hand });
  if (kind === 'empty') return notes;
  if (kind === 'one') add(60, 1, 0.8);
  if (kind === 'chords') {
    // dense 12-note chords every 0.25 s (≈150 visible notes)
    for (let t = 0; t < 30; t += 0.25) for (let i = 0; i < 12; i++) add(36 + ((i * 5 + Math.floor(t * 4) * 3) % 60), t, 0.22);
  }
  if (kind === 'short') for (let t = 0; t < 20; t += 0.05) add(21 + Math.floor((t * 37) % 88), t, 0.03);
  if (kind === 'long') {
    for (let i = 0; i < 20; i++) add(30 + i * 3, 0, 40);
    add(21, 0.5, 2);
    add(108, 0.5, 2);
  }
  if (kind === 'edges') {
    for (let t = 0; t < 20; t += 0.4) {
      add(21, t, 0.3);
      add(22, t + 0.2, 0.3);
      add(107, t, 0.3);
      add(108, t + 0.2, 0.3);
    }
  }
  return notes;
}

function makeRenderer(H: number, decal: Partial<DecalSettings>, extra: Partial<VisualSettings> = {}) {
  const W = Math.round((H * 16) / 9);
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  const vs: VisualSettings = {
    ...DEFAULT_VISUAL,
    range: (q.get('range') as VisualSettings['range']) ?? 'full',
    ...extra,
    decal: { ...DEFAULT_VISUAL.decal, source: 'pattern', ...decal },
  };
  const r = new PianoRollRenderer(c, vs);
  r.resize(W, H);
  const kind = q.get('notes') ?? 'demo';
  const d = bachPreludeDemo();
  r.setNotes(notesFor(kind), [], kind === 'demo' ? d.tempo : null);
  return { r, c, W, H };
}

function digest(c: HTMLCanvasElement): number {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 3) h = Math.imul(h ^ d[i], 16777619);
  return h >>> 0;
}

function decalFromQuery(): Partial<DecalSettings> {
  return {
    patternId: q.get('id') ?? 'meadow',
    tint: Number(q.get('tint') ?? DEFAULT_VISUAL.decal.tint),
    anchor: (q.get('anchor') as 'note' | 'screen') ?? 'note',
    scale: Number(q.get('scale') ?? 1),
    opacity: Number(q.get('opacity') ?? 1),
    source: q.get('none') ? 'none' : 'pattern',
  };
}

async function main() {
  if (mode === 'real') {
    const { r } = makeRenderer(Number(q.get('h') ?? 1080), decalFromQuery());
    const muted = q.get('muted');
    r.render({ time: Number(q.get('t') ?? 6.3), mutedHands: muted ? { L: muted.includes('L'), R: muted.includes('R') } : undefined });
  } else if (mode === 'determinism') {
    const { r, c } = makeRenderer(720, decalFromQuery());
    r.render({ time: 5.37 });
    const a = digest(c);
    for (const t of [20.1, 0.2, 13.3, 5.0]) r.render({ time: t });
    r.render({ time: 5.37 });
    const b = digest(c);
    // second renderer instance (fresh caches for its resampled size are shared module-level)
    const r2 = makeRenderer(720, decalFromQuery());
    r2.r.render({ time: 5.37 });
    const c2 = digest(r2.c);
    out.det = { a, b, c2, same: a === b && b === c2 };
  } else if (mode === 'state') {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext('2d')!;
    const tile = getPatternTile('meadow')!;
    ctx.globalAlpha = 0.37;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#123456';
    ctx.strokeStyle = '#abcdef';
    ctx.shadowBlur = 7;
    ctx.shadowColor = 'rgba(1,2,3,0.5)';
    ctx.lineWidth = 3;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.setTransform(1, 0, 0, 1, 3, 4);
    const snap = () =>
      JSON.stringify([ctx.globalAlpha, ctx.globalCompositeOperation, ctx.fillStyle, ctx.strokeStyle, ctx.shadowBlur, ctx.shadowColor, ctx.lineWidth, ctx.imageSmoothingEnabled, ctx.imageSmoothingQuality, ctx.getTransform().toString()]);
    const before = snap();
    const results: Record<string, boolean> = {};
    const cases: [string, { x: number; y: number; w: number; h: number }, Partial<DecalSettings>, boolean][] = [
      ['normal', { x: 10, y: 10, w: 30, h: 100 }, {}, false],
      ['active', { x: 50, y: 10, w: 30, h: 100 }, {}, true],
      ['zero-w', { x: 50, y: 10, w: 0, h: 100 }, {}, false],
      ['nan', { x: NaN, y: 10, w: 30, h: 100 }, {}, false],
      ['opacity0', { x: 50, y: 10, w: 30, h: 100 }, { opacity: 0 }, false],
      ['screen', { x: 90, y: -50, w: 30, h: 600 }, { anchor: 'screen' }, true],
      ['tiny', { x: 130, y: 10, w: 2, h: 2 }, {}, false],
    ];
    for (const [name, rect, st, active] of cases) {
      try {
        paintNoteDecal(ctx, rect, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: { ...DEFAULT_VISUAL.decal, ...st }, color: hexToRgb('#4f9dff'), noteId: 5, anchorY: rect.y + rect.h, scale: 1, active });
        results[name] = snap() === before;
      } catch (e) {
        results[name + '_threw'] = true;
        out.err = String(e);
      }
    }
    // clip released? fill whole canvas and check a far pixel
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 400, 300);
    const px = ctx.getImageData(390, 290, 1, 1).data;
    out.state = { before, after: snap(), results, clipReleased: px[0] === 255 && px[1] === 0 };
  } else if (mode === 'perf') {
    // real renderer frame time, decal vs no decal, alternating blocks
    const H = Number(q.get('h') ?? 1080);
    const dq = decalFromQuery();
    const on = makeRenderer(H, dq);
    const off = makeRenderer(H, { ...dq, source: 'none' });
    const t0 = Number(q.get('t') ?? 3);
    const frames = 30;
    const block = (x: typeof on, start: number) => {
      const ctx = x.c.getContext('2d')!;
      ctx.getImageData(0, 0, 1, 1);
      const s = performance.now();
      for (let f = 0; f < frames; f++) x.r.render({ time: start + f / 60 });
      ctx.getImageData(0, 0, 1, 1);
      return (performance.now() - s) / frames;
    };
    block(on, t0);
    block(off, t0);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 8; i++) {
      a.push(block(on, t0 + i * 0.5));
      b.push(block(off, t0 + i * 0.5));
    }
    const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
    // count visible notes
    let vis = 0;
    const ns = notesFor(q.get('notes') ?? 'demo');
    for (const n of ns) if (n.start < t0 + 3 + 2 && n.start + n.dur > t0) vis++;
    out.perf = { H, withDecal: +med(a).toFixed(2), without: +med(b).toFixed(2), cost: +(med(a) - med(b)).toFixed(2), approxVisible: vis };
  } else if (mode === 'firstpaint') {
    // cost of the first paint at a new (size, tint, alpha) — tile gen + resample + bake
    const res: Record<string, number> = {};
    for (const p of DECAL_PATTERNS) {
      const s = performance.now();
      getPatternTile(p.id);
      res['gen_' + p.id] = +(performance.now() - s).toFixed(1);
    }
    const tile = getPatternTile('meadow')!;
    const c = document.createElement('canvas');
    c.width = 3840;
    c.height = 2160;
    const ctx = c.getContext('2d')!;
    for (const [sc, us] of [[1, 1], [2, 1], [2, 3], [1.333, 3]] as const) {
      const s = performance.now();
      paintNoteDecal(ctx, { x: 10, y: 10, w: 60, h: 300 }, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: { ...DEFAULT_VISUAL.decal, scale: us }, color: hexToRgb('#4f9dff'), noteId: 1, anchorY: 310, scale: sc, active: false });
      ctx.getImageData(0, 0, 1, 1);
      res[`firstPaint_sc${sc}_user${us}`] = +(performance.now() - s).toFixed(1);
    }
    // tint slider drag: 20 different tints
    const s = performance.now();
    for (let i = 0; i < 20; i++)
      paintNoteDecal(ctx, { x: 10, y: 10, w: 60, h: 300 }, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: { ...DEFAULT_VISUAL.decal, tint: i / 20 + 0.013 }, color: hexToRgb('#4f9dff'), noteId: 1, anchorY: 310, scale: 2, active: false });
    ctx.getImageData(0, 0, 1, 1);
    res.tintDragPerStep_2160p = +((performance.now() - s) / 20).toFixed(1);
    out.first = res;
  } else if (mode === 'longperf') {
    // a single very tall note (much taller than the screen), drawn repeatedly
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    const ctx = c.getContext('2d')!;
    const tile = getPatternTile('meadow')!;
    const res: Record<string, number> = {};
    for (const h of [800, 8000, 40000]) {
      const s = performance.now();
      for (let i = 0; i < 100; i++)
        paintNoteDecal(ctx, { x: 100 + (i % 40) * 40, y: 1000 - h, w: 34, h }, 6, { image: tile, imageWidth: 512, imageHeight: 512, settings: DEFAULT_VISUAL.decal, color: hexToRgb('#4f9dff'), noteId: i, anchorY: 1000, scale: 1, active: false });
      ctx.getImageData(0, 0, 1, 1);
      res['h' + h] = +((performance.now() - s) / 100).toFixed(3);
    }
    out.long = res;
  }
  log.textContent = JSON.stringify(out);
  document.body.dataset.done = '1';
}
main().catch((e) => {
  log.textContent = 'ERROR ' + (e as Error).stack;
  document.body.dataset.done = '1';
});

// micro-benchmark: rounded-rect clip vs axis-aligned rect clip for tall notes
if (mode === 'clipbench') {
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const ctx = c.getContext('2d')!;
  const src = document.createElement('canvas');
  src.width = 600;
  src.height = 2000;
  src.getContext('2d')!.drawImage(getPatternTile('meadow')!, 0, 0, 600, 600);
  const run = (kind: string) => {
    ctx.getImageData(0, 0, 1, 1);
    const s = performance.now();
    for (let f = 0; f < 30; f++)
      for (let i = 0; i < 22; i++) {
        const x = 200.3 + i * 58,
          y = 10.4,
          w = 34.6,
          h = 890,
          r = 5;
        ctx.save();
        if (kind === 'round') {
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, r);
          ctx.clip();
          ctx.drawImage(src, 0, 0, 36, 892, Math.floor(x), Math.floor(y), 36, 892);
        } else if (kind === 'split') {
          // body: plain rect clip; caps: rounded clip on 2 small bands
          ctx.beginPath();
          ctx.rect(x, y + r, w, h - 2 * r);
          ctx.clip();
          ctx.drawImage(src, 0, 0, 36, 892, Math.floor(x), Math.floor(y), 36, 892);
          ctx.restore();
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, r);
          ctx.clip();
          ctx.drawImage(src, 0, 0, 36, r + 1, Math.floor(x), Math.floor(y), 36, r + 1);
          ctx.drawImage(src, 0, 0, 36, r + 2, Math.floor(x), Math.floor(y + h - r - 1), 36, r + 2);
        } else {
          ctx.drawImage(src, 0, 0, 36, 892, Math.floor(x), Math.floor(y), 36, 892);
        }
        ctx.restore();
      }
    ctx.getImageData(0, 0, 1, 1);
    return +((performance.now() - s) / 30).toFixed(2);
  };
  const res: Record<string, number[]> = { round: [], split: [], noclip: [] };
  for (let k = 0; k < 5; k++) for (const m of ['round', 'split', 'noclip']) res[m].push(run(m));
  log.textContent = JSON.stringify(res);
  document.body.dataset.done = '1';
}

if (mode === 'washbench') {
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d0c0b0';
  ctx.fillRect(0, 0, 1920, 1080);
  const run = (op: GlobalCompositeOperation) => {
    ctx.getImageData(0, 0, 1, 1);
    const s = performance.now();
    for (let f = 0; f < 30; f++)
      for (let i = 0; i < 22; i++) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(200.3 + i * 58, 10.4, 34.6, 890, 5);
        ctx.clip();
        ctx.globalCompositeOperation = op;
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = 'rgb(240,230,250)';
        ctx.fillRect(200.3 + i * 58, 10.4, 34.6, 890);
        ctx.restore();
      }
    ctx.getImageData(0, 0, 1, 1);
    return +((performance.now() - s) / 30).toFixed(2);
  };
  const res: Record<string, number[]> = { screen: [], 'source-over': [], lighter: [] };
  for (let k = 0; k < 5; k++) for (const m of Object.keys(res)) res[m].push(run(m as GlobalCompositeOperation));
  log.textContent = JSON.stringify(res);
  document.body.dataset.done = '1';
}
