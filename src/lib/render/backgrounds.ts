/** Procedurally drawn built-in backgrounds (resolution independent, no assets to download). */
export interface BackgroundPreset {
  id: string;
  name: string;
  draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void;
}

function rand(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    draw: (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#0d1020');
      g.addColorStop(1, '#07070b');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      const r = c.createRadialGradient(w * 0.5, h * 0.9, 0, w * 0.5, h * 0.9, w * 0.7);
      r.addColorStop(0, 'rgba(70,110,255,0.16)');
      r.addColorStop(1, 'rgba(70,110,255,0)');
      c.fillStyle = r;
      c.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    draw: (c, w, h) => {
      c.fillStyle = '#05080d';
      c.fillRect(0, 0, w, h);
      const blobs: [number, number, number, string][] = [
        [0.2, 0.25, 0.6, 'rgba(32,201,151,0.30)'],
        [0.75, 0.15, 0.5, 'rgba(124,92,255,0.28)'],
        [0.55, 0.55, 0.55, 'rgba(0,160,200,0.18)'],
      ];
      for (const [x, y, r, col] of blobs) {
        const g = c.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * Math.max(w, h));
        g.addColorStop(0, col);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, w, h);
      }
    },
  },
  {
    id: 'nebula',
    name: 'Nebula',
    draw: (c, w, h) => {
      c.fillStyle = '#07050c';
      c.fillRect(0, 0, w, h);
      const g = c.createRadialGradient(w * 0.65, h * 0.35, 0, w * 0.65, h * 0.35, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(200,80,255,0.25)');
      g.addColorStop(0.5, 'rgba(60,40,160,0.15)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      const rnd = rand(7);
      const n = Math.round((w * h) / 9000);
      for (let i = 0; i < n; i++) {
        const a = rnd() * 0.7 + 0.1;
        c.fillStyle = `rgba(255,255,255,${a})`;
        const s = rnd() < 0.08 ? 1.6 : 0.8;
        c.fillRect(rnd() * w, rnd() * h, s * (w / 1920 + 0.5), s * (w / 1920 + 0.5));
      }
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    draw: (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#140b1e');
      g.addColorStop(0.6, '#2a1022');
      g.addColorStop(1, '#3d1a17');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      const r = c.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, w * 0.6);
      r.addColorStop(0, 'rgba(255,140,80,0.35)');
      r.addColorStop(1, 'rgba(255,140,80,0)');
      c.fillStyle = r;
      c.fillRect(0, 0, w, h);
    },
  },
  {
    id: 'grid',
    name: 'Synth Grid',
    draw: (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#0a0614');
      g.addColorStop(1, '#14061c');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(255,79,216,0.10)';
      c.lineWidth = Math.max(1, w / 1920);
      const step = Math.max(24, w / 32);
      for (let x = 0; x < w; x += step) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
      }
      for (let y = 0; y < h; y += step) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
      }
    },
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    draw: (c, w, h) => {
      c.fillStyle = '#121214';
      c.fillRect(0, 0, w, h);
      const r = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
      r.addColorStop(0, 'rgba(255,255,255,0.05)');
      r.addColorStop(1, 'rgba(0,0,0,0.5)');
      c.fillStyle = r;
      c.fillRect(0, 0, w, h);
    },
  },
];

export const getBackgroundPreset = (id: string) => BACKGROUND_PRESETS.find((b) => b.id === id) ?? BACKGROUND_PRESETS[0];
