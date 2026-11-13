/** What GameStage needs from a game: its rules (lib/games) plus drawing on a 2D canvas. */
import type { GameSynth } from '../../lib/games/synth';

export type Phase = 'ready' | 'playing' | 'over';

export type GameInput = { kind: 'press' } | { kind: 'dir'; dir: 'up' | 'down' | 'left' | 'right' };

export interface GameEngine {
  /** the board's size in CSS pixels changed */
  resize(width: number, height: number): void;
  /** advance by dt ms; true when the picture changed */
  update(dtMs: number): boolean;
  /** draw (the context is already scaled to CSS pixels) */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  input(i: GameInput): void;
  phase(): Phase;
  score(): number;
  /** a new run, on the ready screen */
  restart(): void;
}

export interface EngineOptions {
  synth: GameSynth;
  reducedMotion: boolean;
}

/** colors of the app's dark theme (src/index.css) */
export const C = {
  bg: '#08080b',
  ink900: '#0c0c10',
  ink850: '#111116',
  ink800: '#15151b',
  ink750: '#1a1a21',
  ink700: '#212129',
  ink600: '#2b2b35',
  ink500: '#3a3a46',
  ink400: '#5c5c6b',
  ink300: '#8b8b9b',
  ink200: '#b4b4c2',
  ink100: '#dcdce4',
  ink50: '#f1f1f5',
  accent300: '#a9bbff',
  accent400: '#8aa2ff',
  accent500: '#6d8cff',
  accent600: '#5672e8',
  accent700: '#4258bd',
  amber: '#f5a524',
  ok: '#34d399',
  bad: '#f87171',
} as const;

/** an eighth note (head, stem and flag) centered on its head, `r` = head radius */
export function drawEighthNote(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, tilt = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (tilt) ctx.rotate(tilt);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.18, r * 0.86, -0.38, 0, Math.PI * 2);
  ctx.fill();
  const sx = r * 1.02;
  ctx.lineWidth = Math.max(1, r * 0.26);
  ctx.beginPath();
  ctx.moveTo(sx, -r * 0.2);
  ctx.lineTo(sx, -r * 3.2);
  ctx.stroke();
  // the flag: a filled curve hanging from the top of the stem
  ctx.beginPath();
  ctx.moveTo(sx, -r * 3.2);
  ctx.bezierCurveTo(sx + r * 0.25, -r * 2.5, sx + r * 1.55, -r * 2.2, sx + r * 1.05, -r * 1.1);
  ctx.bezierCurveTo(sx + r * 1.2, -r * 1.9, sx + r * 0.5, -r * 2.2, sx, -r * 2.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
