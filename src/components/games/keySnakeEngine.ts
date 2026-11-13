/**
 * "Key Snake" on a canvas: the rules are lib/games/keySnake; this draws the board (one column per
 * white key, a keyboard below it) and plays the notes. It only redraws when something moved.
 */
import { newSnake, pitchColumn, snakeConfig, steer, startSnake, stepSnake, type SnakeConfig, type SnakeEvent, type SnakeState } from '../../lib/games/keySnake';
import { isBlackKey, noteName, whiteKeyIndex } from '../../lib/games/melodies';
import { C, type EngineOptions, type GameEngine } from './engine';

/** board layout in CSS pixels */
interface Layout {
  cell: number;
  x0: number;
  y0: number;
  stripH: number;
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

export function createKeySnake({ synth, reducedMotion }: EngineOptions): GameEngine {
  let cfg: SnakeConfig = snakeConfig(0.8, reducedMotion);
  let seed = (Date.now() & 0xffff) + 7;
  let tune = 1;
  let s: SnakeState = newSnake(cfg, seed, tune);
  let lay: Layout = { cell: 10, x0: 0, y0: 0, stripH: 20 };
  const events: SnakeEvent[] = [];
  /** the white-key letter of each column, and whether a black key follows it */
  let colInfo: { letter: string; octave: number; black: boolean }[] = [];

  const layout = (w: number, h: number) => {
    const cell = Math.max(6, Math.floor(Math.min(w / cfg.cols, h / (cfg.rows + 2.6))));
    const stripH = Math.round(cell * 2.4);
    const bw = cell * cfg.cols;
    const bh = cell * cfg.rows + stripH;
    lay = { cell, x0: Math.floor((w - bw) / 2), y0: Math.floor((h - bh) / 2), stripH };
    const base = whiteKeyIndex(cfg.lowC);
    colInfo = Array.from({ length: cfg.cols }, (_, i) => {
      const wi = base + i;
      const letter = LETTERS[wi % 7];
      return { letter, octave: Math.floor(wi / 7) - 1, black: letter !== 'E' && letter !== 'B' };
    });
  };

  return {
    resize(w, h) {
      const next = snakeConfig(w / Math.max(1, h), reducedMotion);
      // a new board shape only between runs (a running line must stay on its board)
      if ((next.cols !== cfg.cols || next.rows !== cfg.rows) && s.phase !== 'playing') {
        cfg = next;
        s = newSnake(cfg, seed, tune);
      }
      layout(w, h);
    },
    update(dt) {
      events.length = 0;
      stepSnake(s, cfg, dt, events);
      for (const e of events) {
        if (e === 'eat' && s.lastPitch !== null) synth.play(s.lastPitch);
        else if (e === 'crash') synth.thud();
      }
      return events.length > 0;
    },
    draw(ctx, w, h) {
      const { cell, x0, y0, stripH } = lay;
      const bh = cell * cfg.rows;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);
      // one lane per white key; the lane of the note to eat is lit
      const tokenCol = s.token?.x ?? -1;
      for (let i = 0; i < cfg.cols; i++) {
        ctx.fillStyle = i === tokenCol ? '#1d1b17' : i % 2 ? C.ink850 : C.ink800;
        ctx.fillRect(x0 + i * cell, y0, cell, bh);
      }
      // faint row marks
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      for (let r = 1; r < cfg.rows; r++) ctx.fillRect(x0, y0 + r * cell, cell * cfg.cols, 1);
      ctx.strokeStyle = C.ink600;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, cell * cfg.cols - 1, bh - 1);

      // the keyboard under the board: one white key per column
      const ky = y0 + bh + 2;
      const lit = s.lastPitch !== null && s.moves - s.lastPitchMove < 3 ? s.lastPitch : null;
      const litCol = lit !== null ? pitchColumn(lit, cfg) : -1;
      const target = s.token ? s.token.x : -1;
      for (let i = 0; i < cfg.cols; i++) {
        const x = x0 + i * cell;
        ctx.fillStyle = i === litCol && lit !== null && !isBlackKey(lit) ? C.accent400 : C.ink100;
        ctx.fillRect(x + 0.5, ky, cell - 1, stripH - 2);
        if (i === target) {
          ctx.fillStyle = C.amber;
          ctx.fillRect(x + 0.5, ky + stripH - 2 - Math.max(3, cell * 0.22), cell - 1, Math.max(3, cell * 0.22));
        }
        if (colInfo[i]?.letter === 'C' && cell >= 12) {
          ctx.fillStyle = C.ink400;
          ctx.font = `600 ${Math.round(cell * 0.42)}px Inter Variable, Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(`C${colInfo[i].octave}`, x + cell / 2, ky + stripH - Math.max(5, cell * 0.35));
        }
      }
      for (let i = 0; i < cfg.cols - 1; i++) {
        if (!colInfo[i]?.black) continue;
        const isLit = lit !== null && isBlackKey(lit) && i === litCol;
        ctx.fillStyle = isLit ? C.accent500 : C.ink900;
        ctx.fillRect(x0 + (i + 1) * cell - cell * 0.3, ky, cell * 0.6, stripH * 0.58);
      }

      // the line of notes: head brightest
      const n = s.body.length;
      const inset = Math.max(1, Math.round(cell * 0.08));
      for (let i = n - 1; i >= 0; i--) {
        const c = s.body[i];
        const t = n > 1 ? i / (n - 1) : 0;
        ctx.fillStyle = i === 0 ? (s.phase === 'over' ? C.bad : C.accent300) : t < 0.5 ? C.accent500 : t < 0.8 ? C.accent600 : C.accent700;
        roundRect(ctx, x0 + c.x * cell + inset, y0 + c.y * cell + inset, cell - inset * 2, cell - inset * 2, cell * 0.28);
      }
      // a note head on the head of the line
      const hd = s.body[0];
      ctx.fillStyle = C.ink900;
      ctx.beginPath();
      ctx.ellipse(x0 + hd.x * cell + cell / 2, y0 + hd.y * cell + cell / 2, cell * 0.24, cell * 0.17, -0.4, 0, Math.PI * 2);
      ctx.fill();

      // the note to eat
      const tk = s.token;
      if (tk) {
        const cx = x0 + tk.x * cell + cell / 2;
        const cy = y0 + tk.y * cell + cell / 2;
        ctx.fillStyle = C.amber;
        ctx.beginPath();
        ctx.ellipse(cx - cell * 0.08, cy + cell * 0.12, cell * 0.27, cell * 0.2, -0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx + cell * 0.14, cy - cell * 0.38, Math.max(1.5, cell * 0.08), cell * 0.5);
        if (cell >= 14) {
          ctx.fillStyle = C.ink50;
          ctx.font = `700 ${Math.round(cell * 0.36)}px Inter Variable, Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(noteName(tk.pitch), cx + cell * 0.36, cy - cell * 0.2);
        }
      }
    },
    input(i) {
      synth.unlock();
      if (i.kind === 'dir') steer(s, i.dir);
      else startSnake(s);
    },
    phase: () => s.phase,
    score: () => s.score,
    restart() {
      seed++;
      tune = s.tune.melody + (s.tune.note > 0 ? 1 : 0);
      s = newSnake(cfg, seed, tune);
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}
