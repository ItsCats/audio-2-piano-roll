import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOPPER_DT,
  HOPPER_FLOOR,
  circleHitsRect,
  gapSize,
  hitsBar,
  hopperConfig,
  hopperSpeed,
  newHopper,
  queueHop,
  resizeHopper,
  stepHopper,
  type HopperEvent,
  type HopperState,
} from '../../src/lib/games/noteHopper';
import {
  enqueueDir,
  moveSnake,
  newSnake,
  pitchColumn,
  snakeConfig,
  snakeInterval,
  steer,
  stepSnake,
  swipeDir,
  type SnakeConfig,
  type SnakeEvent,
} from '../../src/lib/games/keySnake';
import { MELODIES, isBlackKey, melodyCursor, nextNote, noteName, whiteKeyIndex } from '../../src/lib/games/melodies';
import { OFFER_AFTER_SEC, loadBest, loadSoundOn, offerGame, saveBest, saveSoundOn } from '../../src/lib/games/offer';
import { canvasScale, frameDue, frameWait, gameFps } from '../../src/lib/games/loop';
import { makeRng, nextRandom } from '../../src/lib/games/rng';

describe('melodies', () => {
  it('fit the keyboard strip (G3–G5) and wrap to the next tune', () => {
    for (const m of MELODIES) {
      expect(m.notes.length).toBeGreaterThan(20);
      for (const p of m.notes) expect(p >= 55 && p <= 79).toBe(true);
    }
    let c = melodyCursor(0);
    const first: number[] = [];
    for (let i = 0; i < MELODIES[0].notes.length; i++) {
      const n = nextNote(c);
      first.push(n.pitch);
      c = n.cursor;
    }
    expect(first).toEqual(MELODIES[0].notes);
    expect(c).toEqual({ melody: 1, note: 0 });
    expect(melodyCursor(-1).melody).toBe(MELODIES.length - 1);
  });
  it('names keys', () => {
    expect(noteName(60)).toBe('C');
    expect(noteName(75)).toBe('D♯');
    expect(isBlackKey(66)).toBe(true);
    expect(isBlackKey(64)).toBe(false);
    expect(whiteKeyIndex(62) - whiteKeyIndex(60)).toBe(1);
    expect(whiteKeyIndex(63)).toBe(whiteKeyIndex(62));
    expect(whiteKeyIndex(72) - whiteKeyIndex(60)).toBe(7);
  });
});

describe('Note Hopper', () => {
  const cfg = hopperConfig(56);
  const run = (s: HopperState, sec: number, autopilot = false) => {
    const events: HopperEvent[] = [];
    for (let t = 0; t < sec && s.phase !== 'over'; t += 1 / 30) {
      if (autopilot) {
        // hop when below the center of the next gap ahead
        const next = s.bars.find((b) => b.x + cfg.barWidth >= cfg.x - cfg.radius);
        const target = next ? next.gapY + 3 : 45;
        if (s.y > target && s.vy > -10) queueHop(s);
      }
      stepHopper(s, cfg, 1 / 30, events);
    }
    return events;
  };

  it('circle/rectangle collision', () => {
    expect(circleHitsRect(0, 0, 1, 0.5, -1, 2, 2)).toBe(true); // center inside
    expect(circleHitsRect(0, 0, 1, 1.5, -1, 2, 2)).toBe(false); // 1.5 away
    expect(circleHitsRect(0, 0, 1, 0.9, -1, 2, 2)).toBe(true); // edge within the radius
    expect(circleHitsRect(0, 0, 1, 0.8, 0.8, 2, 2)).toBe(false); // corner at distance 1.13
    expect(circleHitsRect(0, 0, 1, 0.6, 0.6, 2, 2)).toBe(true); // corner at distance 0.85
  });

  it('bars: the gap is free, its edges are not', () => {
    const bar = { x: cfg.x - 2, gapY: 50, gap: 30, passed: false, pitch: 0 };
    expect(hitsBar(50, cfg, bar)).toBe(false);
    expect(hitsBar(35 + cfg.radius + 0.1, cfg, bar)).toBe(false);
    expect(hitsBar(35 + cfg.radius - 0.5, cfg, bar)).toBe(true);
    expect(hitsBar(65 - cfg.radius + 0.5, cfg, bar)).toBe(true);
    expect(hitsBar(20, cfg, bar)).toBe(true);
  });

  it('speed rises with the score up to a cap; gaps shrink to a floor; reduced motion is gentler', () => {
    expect(hopperSpeed(0, cfg)).toBe(cfg.baseSpeed);
    expect(hopperSpeed(10, cfg)).toBeGreaterThan(hopperSpeed(0, cfg));
    expect(hopperSpeed(1000, cfg)).toBe(cfg.maxSpeed);
    expect(gapSize(0, cfg)).toBe(cfg.gapStart);
    expect(gapSize(1000, cfg)).toBe(cfg.gapMin);
    const calm = hopperConfig(56, true);
    expect(calm.baseSpeed).toBeLessThan(cfg.baseSpeed);
    expect(calm.maxSpeed).toBeLessThan(cfg.maxSpeed);
    expect(calm.gapMin).toBeGreaterThan(cfg.gapMin);
  });

  it('waits on the ready screen; the first hop starts the run; the input queue holds at most 2 hops', () => {
    const s = newHopper(cfg, 1);
    const y0 = s.y;
    run(s, 2);
    expect(s.phase).toBe('ready');
    expect(s.y).toBe(y0);
    queueHop(s);
    queueHop(s);
    queueHop(s);
    expect(s.phase).toBe('playing');
    expect(s.hops).toBe(2);
    const ev: HopperEvent[] = [];
    stepHopper(s, cfg, HOPPER_DT * 2.5, ev);
    expect(ev.filter((e) => e === 'hop')).toHaveLength(2);
    expect(s.vy).toBeLessThan(0);
  });

  it('falling onto the keyboard ends the run; hops are ignored after that', () => {
    const s = newHopper(cfg, 1);
    queueHop(s);
    const ev = run(s, 5);
    expect(ev).toContain('crash');
    expect(s.phase).toBe('over');
    expect(s.y + cfg.radius).toBeLessThanOrEqual(HOPPER_FLOOR + 1e-9);
    queueHop(s);
    expect(s.hops).toBe(0);
  });

  it('a long frame is capped (no jump through a bar)', () => {
    const s = newHopper(cfg, 1);
    queueHop(s);
    const ev: HopperEvent[] = [];
    stepHopper(s, cfg, 5, ev);
    expect(s.time).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('each gap passed scores a point and plays the next note of the tune', () => {
    const s = newHopper(cfg, 42, 0);
    queueHop(s);
    const played: number[] = [];
    for (let i = 0; i < 30 * 60 && s.phase === 'playing' && played.length < 12; i++) {
      const ev = run(s, 1 / 30, true);
      if (ev.includes('pass')) played.push(s.lastPitch!);
    }
    expect(s.score).toBeGreaterThanOrEqual(12);
    expect(played).toEqual(MELODIES[0].notes.slice(0, played.length));
  });

  it('is deterministic for a seed; bars are evenly spaced and fill a wider screen', () => {
    const a = newHopper(cfg, 7);
    const b = newHopper(cfg, 7);
    expect(a.bars.map((x) => x.gapY)).toEqual(b.bars.map((x) => x.gapY));
    expect(newHopper(cfg, 8).bars[0].gapY).not.toBe(a.bars[0].gapY);
    const wide = hopperConfig(170);
    const w = newHopper(wide, 7);
    for (let i = 1; i < w.bars.length; i++) expect(w.bars[i].x - w.bars[i - 1].x).toBeCloseTo(wide.spacing);
    expect(w.bars[w.bars.length - 1].x).toBeGreaterThan(wide.width - wide.spacing);
    const n = a.bars.length;
    resizeHopper(a, wide);
    expect(a.bars.length).toBeGreaterThan(n);
    // every gap within reach of the one before
    for (let i = 1; i < w.bars.length; i++) expect(Math.abs(w.bars[i].gapY - w.bars[i - 1].gapY)).toBeLessThanOrEqual(34);
  });

  it('keeps a bounded number of bars over a long run', () => {
    const s = newHopper(cfg, 3);
    queueHop(s);
    for (let i = 0; i < 30 * 120 && s.phase === 'playing'; i++) run(s, 1 / 30, true);
    expect(s.bars.length).toBeLessThan(8);
  });
});

describe('Key Snake', () => {
  const cfg: SnakeConfig = { ...snakeConfig(0.8), rows: 12 };

  it('board size follows the screen', () => {
    expect(snakeConfig(0.6).cols).toBe(14);
    expect(snakeConfig(1.6).cols).toBe(21);
    expect(snakeConfig(1.6).lowC).toBe(48);
    expect(snakeConfig(0.2).rows).toBe(24);
    expect(snakeConfig(3).rows).toBe(10);
    expect(snakeConfig(1, true).startInterval).toBeGreaterThan(snakeConfig(1).startInterval);
  });

  it('input queue: no repeats, no reversing, at most 3', () => {
    expect(enqueueDir([], 'right', 'left')).toEqual([]);
    expect(enqueueDir([], 'right', 'right')).toEqual([]);
    expect(enqueueDir([], 'right', 'up')).toEqual(['up']);
    expect(enqueueDir(['up'], 'right', 'down')).toEqual(['up']);
    expect(enqueueDir(['up'], 'right', 'left')).toEqual(['up', 'left']);
    expect(enqueueDir(['up', 'left', 'down'], 'right', 'right')).toEqual(['up', 'left', 'down']);
  });

  it('swipes', () => {
    expect(swipeDir(5, 3)).toBeNull();
    expect(swipeDir(40, 10)).toBe('right');
    expect(swipeDir(-40, 10)).toBe('left');
    expect(swipeDir(10, 40)).toBe('down');
    expect(swipeDir(10, -40)).toBe('up');
  });

  it('speed rises with the score up to a cap', () => {
    expect(snakeInterval(0, cfg)).toBe(cfg.startInterval);
    expect(snakeInterval(5, cfg)).toBeLessThan(cfg.startInterval);
    expect(snakeInterval(1000, cfg)).toBe(cfg.minInterval);
  });

  it('notes sit in their key’s column, folded into the board', () => {
    const c = { cols: 14, lowC: 60 };
    expect(pitchColumn(60, c)).toBe(0);
    expect(pitchColumn(62, c)).toBe(1);
    expect(pitchColumn(63, c)).toBe(1); // D♯ on D
    expect(pitchColumn(76, c)).toBe(9); // E5
    expect(pitchColumn(55, c)).toBe(4); // G3 folds up to G4
    expect(pitchColumn(84, c)).toBe(7); // C6 folds down to C5
  });

  it('the first token is the tune’s first note, in its column, not on the line', () => {
    const s = newSnake(cfg, 5, 1);
    const pitch = MELODIES[1].notes[0];
    expect(s.token!.pitch).toBe(pitch);
    expect(s.token!.x).toBe(pitchColumn(pitch, cfg));
    expect(s.body.some((c) => c.x === s.token!.x && c.y === s.token!.y)).toBe(false);
  });

  it('moves on the clock; the edge ends the run', () => {
    const s = newSnake(cfg, 5);
    const out: SnakeEvent[] = [];
    stepSnake(s, cfg, 1000, out);
    expect(out).toEqual([]); // ready: waits
    steer(s, 'up');
    expect(s.phase).toBe('playing');
    stepSnake(s, cfg, cfg.startInterval - 1, out);
    expect(out).toEqual([]);
    stepSnake(s, cfg, 1, out);
    expect(out).toHaveLength(1);
    expect(s.dir).toBe('up');
    for (let i = 0; i < 40 && s.phase === 'playing'; i++) moveSnake(s, cfg);
    expect(s.phase).toBe('over');
    expect(s.body[0].y).toBe(0);
  });

  it('eating grows the line, scores and plays the next note', () => {
    const s = newSnake(cfg, 5, 0);
    s.phase = 'playing';
    const h = s.body[0];
    s.token = { x: h.x + 1, y: h.y, pitch: 64, sharp: false };
    const len = s.body.length;
    expect(moveSnake(s, cfg)).toBe('eat');
    expect(s.score).toBe(1);
    expect(s.lastPitch).toBe(MELODIES[0].notes[0]);
    expect(s.token!.pitch).toBe(MELODIES[0].notes[1]);
    moveSnake(s, cfg);
    expect(s.body.length).toBe(len + 1);
  });

  it('running into itself ends the run, but the cell the tail leaves is free', () => {
    const s = newSnake(cfg, 5);
    s.phase = 'playing';
    s.token = null;
    // a 2×2 loop: head chases its own tail
    s.body = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 5 },
    ];
    s.dir = 'up';
    s.queue = ['right'];
    expect(moveSnake(s, cfg)).toBe('move');
    const t = newSnake(cfg, 5);
    t.phase = 'playing';
    t.token = null;
    t.body = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ];
    t.dir = 'up';
    t.queue = ['right'];
    expect(moveSnake(t, cfg)).toBe('crash');
  });

  it('a long frame moves a few steps at most', () => {
    const s = newSnake(cfg, 5);
    steer(s, 'up');
    const out: SnakeEvent[] = [];
    stepSnake(s, cfg, 10_000, out);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

describe('offer, pacing, storage', () => {
  const job = (o: Partial<Parameters<typeof offerGame>[0] & object> = {}) => ({ stage: 'analyzing', kind: 'file', startedAt: 0, ...o });

  it('offers a game for imports taking longer than 20 s', () => {
    expect(offerGame(null, 0)).toBe(false);
    expect(offerGame(job(), 10_000)).toBe(false);
    expect(offerGame(job(), OFFER_AFTER_SEC * 1000)).toBe(true);
    expect(offerGame(job({ stage: 'done' }), 60_000)).toBe(false);
    expect(offerGame(job({ stage: 'error' }), 60_000)).toBe(false);
    expect(offerGame(job({ kind: 'midi' }), 60_000)).toBe(false);
    expect(offerGame(job({ kind: 'demo' }), 60_000)).toBe(false);
    expect(offerGame(job({ kind: 'score' }), 60_000)).toBe(false);
    expect(offerGame(job({ kind: 'score', sheet: 'pdf' }), 60_000)).toBe(true);
    // measured: 3 s in, 60 s left → offered right away; 3 s in, 4 s left → not
    expect(offerGame(job({ rate: { etaSec: 60, at: 3000 } }), 3000)).toBe(true);
    expect(offerGame(job({ rate: { etaSec: 4, at: 3000 } }), 3000)).toBe(false);
  });

  it('frame pacing and canvas scale', () => {
    expect(gameFps(true)).toBe(30);
    expect(gameFps(false)).toBe(60);
    expect(gameFps(false, true)).toBe(30);
    expect(gameFps(true, false)).toBe(30);
    expect(frameDue(1000, 1000 - 16.7, 60)).toBe(true);
    expect(frameDue(1000, 1000 - 16.7, 30)).toBe(false);
    expect(frameDue(1000, 1000 - 33.3, 30)).toBe(true);
    expect(canvasScale(3, true)).toBe(1.5);
    expect(canvasScale(3, false)).toBe(2);
    expect(canvasScale(1, false)).toBe(1);
    expect(canvasScale(NaN, false)).toBe(1);
    // a big board on a high-density screen: capped pixel count
    expect(canvasScale(2, false, 896, 640)).toBeCloseTo(Math.sqrt(750_000 / (896 * 640)), 2);
    expect(canvasScale(3, true, 300, 400)).toBe(1.5);
    expect(canvasScale(3, true, 430, 700)).toBeCloseTo(Math.sqrt(450_000 / (430 * 700)), 2);
    expect(canvasScale(2, false, 300, 200)).toBe(2);
    expect(canvasScale(2, false, 4000, 4000)).toBe(0.5);
    // 30 fps: drawn at 1000 → sleep until ~1019, then wait for the frame; late → ask now
    expect(frameWait(1000, 1000, 30)).toBe(19);
    expect(frameWait(1025, 1000, 30)).toBe(0);
    expect(frameWait(1000, 1000, 60)).toBe(0);
  });

  it('random numbers are seeded', () => {
    const a = makeRng(1);
    const b = makeRng(1);
    const xs = [nextRandom(a), nextRandom(a), nextRandom(a)];
    expect([nextRandom(b), nextRandom(b), nextRandom(b)]).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  const g = globalThis as { localStorage?: Storage };
  afterEach(() => {
    delete g.localStorage;
  });

  it('best scores and sound setting under their own keys; no storage is fine', () => {
    expect(loadBest('note-hopper')).toBe(0);
    expect(saveBest('note-hopper', 5)).toBe(5);
    expect(loadSoundOn()).toBe(true);
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    expect(saveBest('note-hopper', 5)).toBe(5);
    expect(saveBest('note-hopper', 3)).toBe(5);
    expect(loadBest('note-hopper')).toBe(5);
    expect(loadBest('key-snake')).toBe(0);
    saveSoundOn(false);
    expect(loadSoundOn()).toBe(false);
    expect([...store.keys()].sort()).toEqual(['piano2vision-game-best-note-hopper', 'piano2vision-game-sound']);
  });
});

describe('game synth', () => {
  class FakeParam {
    value = 0;
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class FakeNode {
    gain = new FakeParam();
    frequency = new FakeParam();
    type = '';
    onended: (() => void) | null = null;
    connect() {}
    disconnect() {}
    start() {}
    stop() {}
  }
  class FakeCtx {
    static made = 0;
    state: 'running' | 'suspended' | 'closed' = 'running';
    currentTime = 0;
    destination = {};
    oscillators = 0;
    constructor() {
      FakeCtx.made++;
    }
    createGain() {
      return new FakeNode();
    }
    createOscillator() {
      this.oscillators++;
      return new FakeNode();
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    delete g.window;
    vi.useRealTimers();
  });

  it('makes no audio context until a tap, none while muted, sleeps when quiet, wakes to play', async () => {
    vi.useFakeTimers();
    let last: FakeCtx | null = null;
    g.window = {
      AudioContext: class extends FakeCtx {
        constructor() {
          super();
          last = this;
        }
      },
    };
    const { createGameSynth, IDLE_SUSPEND_MS } = await import('../../src/lib/games/synth');
    const muted = createGameSynth(true);
    muted.unlock();
    muted.play(60);
    expect(last).toBeNull();
    const s = createGameSynth(false);
    s.play(60); // before a tap: nothing
    expect(last).toBeNull();
    s.unlock();
    expect(last).not.toBeNull();
    const ctx = last as unknown as FakeCtx;
    s.play(60);
    expect(ctx.oscillators).toBe(2);
    vi.advanceTimersByTime(IDLE_SUSPEND_MS + 10);
    expect(ctx.state).toBe('suspended');
    s.play(64); // wakes and plays
    expect(ctx.state).toBe('running');
    expect(ctx.oscillators).toBe(4);
    s.setMuted(true);
    expect(ctx.state).toBe('suspended');
    s.play(65);
    expect(ctx.oscillators).toBe(4);
    s.close();
    expect(ctx.state).toBe('closed');
  });
});
