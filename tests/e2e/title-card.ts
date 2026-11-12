// Browser harness for the title page renderer (src/lib/render/titleCard), driven by title-card.mjs.
//   window.renderCard(job) draws one card with the real fonts and returns a PNG plus checks:
//   layout boxes, font checks, the ink box of a transparent render, and per-line ink widths.
import { DEFAULT_LOOK, TITLE_PRESETS, resolveLook, type TitleLook, type TitleText } from '../../src/lib/render/titleCard';
import { TitleCardCache, drawTitleCard } from '../../src/lib/render/titleCard/draw';
import { ensureTitleFonts, neededFonts } from '../../src/lib/render/titleCard/fonts';
import { FAMILY } from '../../src/lib/render/titleCard/presets';
import { END_LAYOUT } from '../../src/lib/render/titleCard/exportHooks';
import { FLOURISH_BOUNDS, getFlourishPath } from '../../src/lib/render/titleCard/flourishes';

export const TEXTS: Record<string, TitleText> = {
  clair: { title: 'Clair de Lune', subtitle: 'Suite Bergamasque', composer: 'Debussy', credit: 'Piano2Vision', small: 'For you' },
  nocturne: { title: 'Nocturne', subtitle: 'Op. 9 No. 2', composer: 'Frédéric Chopin', credit: 'Piano2Vision', small: 'Dedicated to you' },
  long: { title: 'The Most Wonderful Moonlight Variations Ever Written For Piano', subtitle: 'Suite for the Long Winter Evenings, Book Two', composer: 'Johann Sebastian Bach and Carl Philipp Emanuel', credit: 'Arranged by a Very Long Channel Name', small: 'Dedicated to everyone who listens' },
  word: { title: 'Pneumonoultramicroscopicsilicovolcanoconiosis', subtitle: '', composer: 'Supercalifragilisticexpialidocious', credit: '', small: '' },
  cjk: { title: '月の光とピアノのための小さな組曲', subtitle: 'ベルガマスク組曲', composer: 'ドビュッシー', credit: 'Piano2Vision', small: '' },
  bare: { title: 'Gymnopédie No. 1', subtitle: '', composer: '', credit: '', small: '' },
  end: { title: 'Thank you for listening', subtitle: '', composer: '', credit: 'Piano2Vision', small: 'See you next time' },
};

interface Job {
  preset: string;
  W: number;
  H: number;
  text: string | TitleText;
  t?: number;
  reveal?: boolean;
  look?: Partial<TitleLook>;
  end?: boolean;
  png?: boolean;
  checks?: boolean;
}

const images: { fill?: ImageBitmap; bg?: ImageBitmap } = {};

async function testImage(): Promise<ImageBitmap> {
  // a synthetic "photo": colourful gradients + circles (made here, no external image)
  const c = new OffscreenCanvas(1200, 800);
  const g = c.getContext('2d')!;
  const lg = g.createLinearGradient(0, 0, 1200, 800);
  lg.addColorStop(0, '#ff6b6b');
  lg.addColorStop(0.5, '#ffd93d');
  lg.addColorStop(1, '#4d96ff');
  g.fillStyle = lg;
  g.fillRect(0, 0, 1200, 800);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsla(${(i * 47) % 360},80%,60%,0.6)`;
    g.beginPath();
    g.arc((i * 233) % 1200, (i * 137) % 800, 40 + ((i * 31) % 90), 0, Math.PI * 2);
    g.fill();
  }
  return createImageBitmap(c);
}

function inkBox(ctx: CanvasRenderingContext2D, W: number, H: number, rect?: { x0: number; y0: number; x1: number; y1: number }) {
  const x0 = Math.max(0, Math.floor(rect?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(rect?.y0 ?? 0));
  const x1 = Math.min(W, Math.ceil(rect?.x1 ?? W));
  const y1 = Math.min(H, Math.ceil(rect?.y1 ?? H));
  if (x1 <= x0 || y1 <= y0) return null;
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const w = x1 - x0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 24) continue;
    const p = (i - 3) / 4;
    const x = (p % w) + x0;
    const y = Math.floor(p / w) + y0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX === Infinity ? null : { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

(window as unknown as Record<string, unknown>).renderCard = async (job: Job) => {
  const text = typeof job.text === 'string' ? TEXTS[job.text] : job.text;
  const lookIn: TitleLook = { ...DEFAULT_LOOK, ...(job.look ?? {}), preset: job.preset as TitleLook['preset'] };
  if (lookIn.fill === 'image') {
    images.fill ??= await testImage();
    lookIn.fillImageId = 'test';
  }
  if (lookIn.bg === 'image') {
    images.bg ??= await testImage();
    lookIn.bgImageId = 'test';
  }
  const look = resolveLook(lookIn, { accent: '#4f9dff' });
  const fontRes = await ensureTitleFonts(look, [text]);
  const needs = neededFonts(look, [text]);
  const fontChecks = needs.map((n) => ({ family: n.font, weight: n.weight, ok: document.fonts.check(`${n.font === 'inter' ? 400 : n.weight} 48px ${FAMILY[n.font]}`) }));
  const c = document.createElement('canvas');
  c.width = job.W;
  c.height = job.H;
  const ctx = c.getContext('2d', { willReadFrequently: !!job.checks })!;
  const cache = new TitleCardCache();
  const duration = 4;
  const t = job.t ?? duration - 1;
  const imgs = { fillImage: images.fill ?? null, bgImage: images.bg ?? null };
  const opts = { duration, reveal: job.reveal ?? true, layout: job.end ? END_LAYOUT : undefined };
  const t0 = performance.now();
  const L = drawTitleCard(ctx, job.W, job.H, look, text, imgs, t, cache, opts);
  const ms1 = performance.now() - t0;
  const t1 = performance.now();
  drawTitleCard(ctx, job.W, job.H, look, text, imgs, t, cache, opts);
  const ms2 = performance.now() - t1;
  const png = job.png ? c.toDataURL('image/png') : null;
  let checks = null;
  if (job.checks) {
    const plain = { ...look, streaks: false, sparkles: false, stars: false, zoom: false, glow: null };
    const cache2 = new TitleCardCache();
    ctx.clearRect(0, 0, job.W, job.H);
    const L2 = drawTitleCard(ctx, job.W, job.H, plain, text, imgs, t, cache2, { ...opts, transparent: true });
    const ink = inkBox(ctx, job.W, job.H);
    const border = Math.ceil(0.01 * Math.min(job.W, job.H));
    const borderClear = !ink || (ink.x0 >= border && ink.y0 >= border && ink.x1 <= job.W - border && ink.y1 <= job.H - border);
    // ink width of each block without side dividers vs its measured width
    const widths = L2.blocks
      .filter((b) => b.lines.length && !(b.divider && b.divider.mode === 'side'))
      .map((b) => {
        const rows = { x0: 0, x1: job.W, y0: b.baselines[0] - b.cap - 1, y1: b.baselines[0] + 1 };
        const box = b.lines.length === 1 && b.spec?.upper ? inkBox(ctx, job.W, job.H, rows) : null;
        return { role: b.role, lines: b.lines.length, textW: b.lineWidths[0], ink: box ? box.x1 - box.x0 : null };
      });
    // a centred ornament / rule must be drawn across its whole box (catches clipped flourishes)
    const dividers = L2.blocks
      .filter((b) => b.divider && b.divider.mode === 'below')
      .map((b) => {
        const r = b.divider!.boxes[0];
        const box = inkBox(ctx, job.W, job.H, { x0: 0, x1: job.W, y0: r.y0 - 2, y1: r.y1 + 2 });
        return { role: b.role, kind: b.divider!.kind, boxW: r.x1 - r.x0, ink: box ? box.x1 - box.x0 : null };
      });
    checks = { ink, borderClear, widths, dividers, layout: { safe: L2.safe, content: L2.content, blocks: L2.blocks.map((b) => ({ role: b.role, lines: b.lines, px: b.px, box: b.box, divider: b.divider ? { mode: b.divider.mode, boxes: b.divider.boxes } : null })) } };
  }
  return { png, ms1, ms2, fontRes, fontChecks, k: L.k, blocks: L.blocks.map((b) => ({ role: b.role, lines: b.lines, px: Math.round(b.px), mode: b.divider?.mode ?? null })), checks };
};

/** Ink bounds of each flourish path (em), to compare with FLOURISH_BOUNDS. */
(window as unknown as Record<string, unknown>).flourishInk = () => {
  const S = 200;
  const W = 1400;
  const H = 600;
  const ox = 1000;
  const oy = 300;
  return (['vine', 'scroll'] as const).map((id) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.translate(ox, oy);
    g.scale(S, S);
    g.fill(getFlourishPath(id));
    const b = inkBox(g, W, H)!;
    return { id, ink: { minX: (b.x0 - ox) / S, maxX: (b.x1 - ox) / S, minY: (b.y0 - oy) / S, maxY: (b.y1 - oy) / S }, bounds: FLOURISH_BOUNDS[id] };
  });
};

(window as unknown as Record<string, unknown>).presets = TITLE_PRESETS.map((p) => p.id);
document.getElementById('log')!.textContent = 'ready';
