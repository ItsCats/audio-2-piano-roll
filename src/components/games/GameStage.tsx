/**
 * Runs one game on a 2D canvas: sizing, the frame loop and input. The loop only runs while a run is
 * being played and not paused (requestAnimationFrame, which the browser also stops for a hidden
 * page), and draws at most `fps` times a second.
 */
import { useEffect, useRef } from 'react';
import { canvasScale, frameDue, frameWait } from '../../lib/games/loop';
import { swipeDir } from '../../lib/games/keySnake';
import type { GameEngine, GameInput, Phase } from './engine';

export interface StageState {
  phase: Phase;
  score: number;
}

/** after a run ends, taps and keys wait this long before starting another (a late tap is not a restart) */
const RESTART_DELAY_MS = 600;

export interface StageHandle {
  input(i: GameInput): void;
  restart(): void;
}

export function GameStage({
  engine,
  paused,
  fps,
  touch,
  swipe,
  keyInput,
  onState,
  handle,
  label,
}: {
  engine: GameEngine;
  paused: boolean;
  fps: number;
  touch: boolean;
  /** steer by swiping (Key Snake); otherwise a tap is a press (Note Hopper) */
  swipe: boolean;
  /** a key's game input (null: not the game's key) */
  keyInput: (e: KeyboardEvent) => GameInput | null;
  onState: (s: StageState) => void;
  handle: React.RefObject<StageHandle | null>;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ paused, onState, keyInput, fps });
  live.current = { paused, onState, keyInput, fps };
  const kickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const cv = canvas.current!;
    const box = wrap.current!;
    const ctx = cv.getContext('2d', { alpha: false });
    if (!ctx) return;
    let w = 0;
    let h = 0;
    let scale = 1;
    let raf = 0;
    let timer = 0;
    let last = 0;
    let lastDraw = -1e9;
    let reported: StageState = { phase: engine.phase(), score: engine.score() };
    let overAt = 0;

    const draw = () => {
      if (!w || !h) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      engine.draw(ctx, w, h);
    };
    const report = () => {
      const phase = engine.phase();
      const score = engine.score();
      if (phase === reported.phase && score === reported.score) return;
      if (phase === 'over' && reported.phase !== 'over') overAt = performance.now();
      reported = { phase, score };
      live.current.onState(reported);
    };
    const shouldRun = () => engine.phase() === 'playing' && !live.current.paused && w > 0;
    const tick = (now: number) => {
      raf = 0;
      if (!shouldRun()) return;
      if (frameDue(now, lastDraw, live.current.fps)) {
        const dt = now - last;
        last = now;
        lastDraw = now;
        if (engine.update(dt)) draw();
        report();
      }
      if (shouldRun()) schedule();
    };
    // sleep until shortly before the next frame is due instead of waking on every display refresh
    const schedule = () => {
      const wait = frameWait(performance.now(), lastDraw, live.current.fps);
      if (wait <= 0) raf = requestAnimationFrame(tick);
      else
        timer = window.setTimeout(() => {
          timer = 0;
          if (shouldRun()) raf = requestAnimationFrame(tick);
        }, wait);
    };
    const kick = () => {
      if (raf || timer || !shouldRun()) return;
      last = performance.now();
      lastDraw = -1e9;
      raf = requestAnimationFrame(tick);
    };
    kickRef.current = kick;

    const resize = () => {
      const r = box.getBoundingClientRect();
      const nw = Math.max(1, Math.floor(r.width));
      const nh = Math.max(1, Math.floor(r.height));
      const ns = canvasScale(window.devicePixelRatio, touch, nw, nh);
      if (nw === w && nh === h && ns === scale) return;
      w = nw;
      h = nh;
      scale = ns;
      cv.width = Math.round(w * scale);
      cv.height = Math.round(h * scale);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      engine.resize(w, h);
      draw();
      kick();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(box);
    window.addEventListener('resize', resize);
    resize();

    const send = (i: GameInput) => {
      if (live.current.paused) return;
      if (engine.phase() === 'over') {
        if (performance.now() - overAt < RESTART_DELAY_MS) return;
        engine.restart();
      }
      engine.input(i);
      draw();
      report();
      kick();
    };
    handle.current = {
      input: send,
      restart: () => {
        engine.restart();
        draw();
        report();
      },
    };

    // pointer: Note Hopper hops on touch-down (no delay); Key Snake steers by swiping, a tap starts
    let start: { id: number; x: number; y: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button > 0) return;
      e.preventDefault();
      box.focus({ preventScroll: true });
      if (!swipe) return send({ kind: 'press' });
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const d = swipeDir(e.clientX - start.x, e.clientY - start.y, touch ? 22 : 30);
      if (!d) return;
      send({ kind: 'dir', dir: d });
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: true };
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      if (!start.moved) send({ kind: 'press' });
      start = null;
    };
    box.addEventListener('pointerdown', down);
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);

    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      // Space / Enter on a focused button presses that button
      if ((e.key === ' ' || e.key === 'Enter') && t && t !== box && /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const i = live.current.keyInput(e);
      if (!i) return;
      e.preventDefault();
      if (e.repeat && i.kind === 'press') return;
      send(i);
    };
    window.addEventListener('keydown', key);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', key);
      box.removeEventListener('pointerdown', down);
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      handle.current = null;
      kickRef.current = () => undefined;
      // free the canvas memory right away
      cv.width = 0;
      cv.height = 0;
    };
  }, [engine, touch, swipe, handle]);

  // resuming restarts the loop
  useEffect(() => {
    if (!paused) kickRef.current();
  }, [paused]);

  return (
    <div
      ref={wrap}
      tabIndex={0}
      role="application"
      aria-label={label}
      className="absolute inset-0 overflow-hidden rounded-xl outline-none select-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
      style={{ touchAction: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
    >
      <canvas ref={canvas} className="block" aria-hidden="true" />
    </div>
  );
}
