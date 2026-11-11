// Renders the same frame with independent renderer instances and compares pixels.
// Exports always use a fresh renderer, so frames must not depend on instance history.
import { PianoRollRenderer } from '../../src/lib/render/renderer';
import { DEFAULT_VISUAL, applyTheme, type VisualSettings } from '../../src/lib/render/settings';
import { bachPreludeDemo } from '../../src/lib/music/demo';

const demo = bachPreludeDemo();

function frame(v: VisualSettings, t: number, history: number[] = [], w = 1280, h = 720): Uint8ClampedArray {
  const c = new OffscreenCanvas(w, h);
  const r = new PianoRollRenderer(c, v);
  r.resize(w, h);
  r.setNotes(demo.notes, demo.pedal, demo.tempo, { tonic: 0, mode: 'major' });
  for (const x of history) r.render({ time: x });
  r.render({ time: t });
  return (c.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(0, 0, w, h).data;
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let n = 0;
  let max = 0;
  let first = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) {
      n++;
      if (first < 0) first = i;
      if (d > max) max = d;
    }
  }
  return { differing: n, max, firstPixel: first < 0 ? null : { x: (first / 4) % 1280, y: Math.floor(first / 4 / 1280) } };
}

async function run(variant: string) {
  let v: VisualSettings = DEFAULT_VISUAL;
  if (variant === 'blossom') v = applyTheme(DEFAULT_VISUAL, 'blossom');
  if (variant === 'plain') v = { ...DEFAULT_VISUAL, particles: false, trails: false };
  if (variant === 'bursts') v = { ...DEFAULT_VISUAL, effects: { ...DEFAULT_VISUAL.effects, bursts: true } };
  if (variant === 'dust') v = { ...DEFAULT_VISUAL, effects: { ...DEFAULT_VISUAL.effects, dust: true } };
  if (variant === 'keylight') v = { ...DEFAULT_VISUAL, effects: { ...DEFAULT_VISUAL.effects, keyLight: true } };
  if (variant === 'realistic') v = { ...DEFAULT_VISUAL, keyboardStyle: 'realistic' };
  if (variant === 'decal') v = { ...DEFAULT_VISUAL, decal: { ...DEFAULT_VISUAL.decal, source: 'pattern' } };
  const t = 5.03;
  const a = frame(v, t);
  const b = frame(v, t);
  const c = frame(v, t, [1, 2, 3, 4, 9, 4.9]);
  return { variant, freshVsFresh: diff(a, b), freshVsWithHistory: diff(a, c) };
}

Object.assign(window, { run });
document.getElementById('log')!.textContent = 'ready';

/** Render one frame and return it as a PNG data URL (used for visual comparisons). */
async function snap(theme: string, t: number, fallingGlow: number, noteBrightness: number, w = 1920, h = 1080) {
  const v: VisualSettings = { ...applyTheme(DEFAULT_VISUAL, theme), fallingGlow, noteBrightness };
  const c = new OffscreenCanvas(w, h);
  const r = new PianoRollRenderer(c, v);
  r.resize(w, h);
  r.setNotes(demo.notes, demo.pedal, demo.tempo, { tonic: 0, mode: 'major' });
  r.render({ time: t });
  const blob = await c.convertToBlob({ type: 'image/png' });
  return await new Promise<string>((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.readAsDataURL(blob);
  });
}

/** Mean / p95 ms per frame for a theme while playing (1080p, every effect the theme enables). */
function perf(theme: string, frames = 180, w = 1920, h = 1080, patch: Partial<VisualSettings> = {}) {
  const v = { ...applyTheme(DEFAULT_VISUAL, theme), ...patch };
  const c = new OffscreenCanvas(w, h);
  const r = new PianoRollRenderer(c, v);
  r.resize(w, h);
  r.setNotes(demo.notes, demo.pedal, demo.tempo, { tonic: 0, mode: 'major' });
  for (let i = 0; i < 30; i++) r.render({ time: 10 + i / 60 }); // warm caches
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const times: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    r.render({ time: 11 + i / 60 });
    ctx.getImageData(0, 0, 1, 1); // flush
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { theme, meanMs: +(times.reduce((s, x) => s + x, 0) / frames).toFixed(2), p95Ms: +times[Math.floor(frames * 0.95)].toFixed(2) };
}
Object.assign(window, { snap, perf });
