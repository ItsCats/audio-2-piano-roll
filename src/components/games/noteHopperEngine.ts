/** "Note Hopper" on a canvas: the rules are lib/games/noteHopper; this draws them and plays the notes. */
import { HOPPER_FLOOR, HOPPER_H, hopperConfig, newHopper, queueHop, resizeHopper, stepHopper, type HopperConfig, type HopperEvent, type HopperState } from '../../lib/games/noteHopper';
import { isBlackKey, noteName } from '../../lib/games/melodies';
import { C, drawEighthNote, type EngineOptions, type GameEngine } from './engine';

/** the keyboard strip: white keys from G3 to G5 (every tune's range) */
const STRIP_LOW = 55;
const STRIP_HIGH = 79;
const WHITE_KEYS = (() => {
  const keys: number[] = [];
  for (let p = STRIP_LOW; p <= STRIP_HIGH; p++) if (!isBlackKey(p)) keys.push(p);
  return keys;
})();

export function createNoteHopper({ synth, reducedMotion }: EngineOptions): GameEngine {
  let cfg: HopperConfig = hopperConfig(60, reducedMotion);
  let seed = (Date.now() & 0xffff) + 1;
  let tune = 0;
  let s: HopperState = newHopper(cfg, seed, tune);
  const events: HopperEvent[] = [];
  let lightPitch: number | null = null;
  let lightFor = 0;

  return {
    resize(w, h) {
      cfg = hopperConfig((w / Math.max(1, h)) * HOPPER_H, reducedMotion);
      if (s.phase === 'ready') s = newHopper(cfg, seed, tune);
      else resizeHopper(s, cfg);
    },
    update(dt) {
      events.length = 0;
      stepHopper(s, cfg, dt / 1000, events);
      for (const e of events) {
        if (e === 'pass' && s.lastPitch !== null) {
          synth.play(s.lastPitch);
          lightPitch = s.lastPitch;
          lightFor = 0.35;
        } else if (e === 'crash') synth.thud();
      }
      if (lightFor > 0) lightFor -= dt / 1000;
      return true;
    },
    draw(ctx, w, h) {
      const k = h / HOPPER_H;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);
      // a staff across the sky
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      for (let i = 0; i < 5; i++) ctx.fillRect(0, Math.round((24 + i * 8) * k), w, Math.max(1, Math.round(k * 0.3)));

      // bars: white keys with a black key down the middle, their gap ends lit in the accent color
      const bw = cfg.barWidth * k;
      for (const bar of s.bars) {
        const x = bar.x * k;
        if (x > w || x + bw < 0) continue;
        const top = (bar.gapY - bar.gap / 2) * k;
        const bottom = (bar.gapY + bar.gap / 2) * k;
        const floor = HOPPER_FLOOR * k;
        ctx.fillStyle = C.ink200;
        ctx.fillRect(x, 0, bw, top);
        ctx.fillRect(x, bottom, bw, floor - bottom);
        ctx.fillStyle = C.ink300;
        ctx.fillRect(x + bw - Math.max(1, k * 0.6), 0, Math.max(1, k * 0.6), top);
        ctx.fillRect(x + bw - Math.max(1, k * 0.6), bottom, Math.max(1, k * 0.6), floor - bottom);
        ctx.fillStyle = C.ink850;
        const bx = x + bw * 0.27;
        const bwid = bw * 0.46;
        ctx.fillRect(bx, 0, bwid, top * 0.62);
        ctx.fillRect(bx, bottom + (floor - bottom) * 0.38, bwid, (floor - bottom) * 0.62);
        ctx.fillStyle = bar.passed ? C.ok : C.accent500;
        const cap = Math.max(2, k * 1.6);
        ctx.fillRect(x, top - cap, bw, cap);
        ctx.fillRect(x, bottom, bw, cap);
      }

      // keyboard strip along the bottom (touching it ends the run); the note just played lights up
      const sy = HOPPER_FLOOR * k;
      const sh = h - sy;
      const kw = w / WHITE_KEYS.length;
      ctx.fillStyle = C.ink900;
      ctx.fillRect(0, sy, w, sh);
      const lit = lightFor > 0 ? lightPitch : null;
      for (let i = 0; i < WHITE_KEYS.length; i++) {
        ctx.fillStyle = WHITE_KEYS[i] === lit ? C.accent400 : C.ink100;
        ctx.fillRect(i * kw + 0.5, sy + 1, kw - 1, sh - 1);
      }
      for (let i = 0; i < WHITE_KEYS.length - 1; i++) {
        const p = WHITE_KEYS[i] + 1;
        if (!isBlackKey(p)) continue;
        ctx.fillStyle = p === lit ? C.accent500 : C.ink900;
        ctx.fillRect((i + 1) * kw - kw * 0.3, sy + 1, kw * 0.6, sh * 0.6);
      }

      // the hopping note
      const tilt = reducedMotion ? 0 : Math.max(-0.3, Math.min(0.45, s.vy / 220));
      drawEighthNote(ctx, cfg.x * k, s.y * k, cfg.radius * k, s.phase === 'over' ? C.bad : C.accent400, tilt);
      // the name of the note just played, above the note
      if (lit !== null) {
        ctx.fillStyle = C.ink50;
        ctx.font = `600 ${Math.round(4.2 * k)}px Inter Variable, Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(noteName(lit), cfg.x * k, (s.y - cfg.radius * 3.6) * k);
      }
    },
    input(i) {
      if (i.kind !== 'press') return;
      synth.unlock();
      queueHop(s);
    },
    phase: () => s.phase,
    score: () => s.score,
    restart() {
      seed++;
      // the next run plays the next tune
      tune = s.tune.melody + (s.tune.note > 0 ? 1 : 0);
      s = newHopper(cfg, seed, tune);
      lightFor = 0;
    },
  };
}
