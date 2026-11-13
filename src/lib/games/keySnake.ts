/**
 * "Key Snake": a line of notes moves over a board whose columns are the white keys of a keyboard,
 * and eats note tokens; each token is the next note of a tune, placed in its own key's column, and
 * grows the line by one. Running into the edge or into itself ends the run. Game rules only (no
 * DOM); the state is changed in place and is deterministic for a given seed.
 */
import { makeRng, randomInt, type Rng } from './rng';
import { melodyCursor, nextNote, whiteKeyIndex, isBlackKey, type MelodyCursor } from './melodies';

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Cell {
  x: number;
  y: number;
}

export interface SnakeConfig {
  /** columns = white keys, from `lowC` up */
  cols: number;
  rows: number;
  /** MIDI number of the C in the first column */
  lowC: number;
  /** ms per move at the start, the fastest, and how much faster per note eaten */
  startInterval: number;
  minInterval: number;
  intervalStep: number;
}

/** Board size for a screen: 2 octaves of columns on a narrow (portrait) screen, 3 on a wide one. */
export function snakeConfig(aspect: number, reducedMotion = false): SnakeConfig {
  const cols = aspect >= 1.2 ? 21 : 14;
  const rows = Math.max(10, Math.min(24, Math.round(cols / Math.max(0.3, aspect))));
  return {
    cols,
    rows,
    lowC: cols === 21 ? 48 : 60,
    startInterval: reducedMotion ? 210 : 165,
    minInterval: reducedMotion ? 130 : 85,
    intervalStep: reducedMotion ? 2 : 3,
  };
}

/** ms per move at a score */
export function snakeInterval(score: number, cfg: SnakeConfig): number {
  return Math.max(cfg.minInterval, cfg.startInterval - score * cfg.intervalStep);
}

/**
 * The column of a note (its white key; a black key sits on the white key to its left), folded by
 * octaves into the board.
 */
export function pitchColumn(pitch: number, cfg: Pick<SnakeConfig, 'cols' | 'lowC'>): number {
  let col = whiteKeyIndex(pitch) - whiteKeyIndex(cfg.lowC);
  while (col < 0) col += 7;
  while (col >= cfg.cols) col -= 7;
  return Math.max(0, col);
}

export const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/**
 * The input queue: a new direction is added unless it repeats or reverses the last queued (or
 * current) one; at most 3 wait. Pure: returns the new queue.
 */
export function enqueueDir(queue: readonly Dir[], current: Dir, d: Dir): Dir[] {
  const last = queue.length ? queue[queue.length - 1] : current;
  if (d === last || d === OPPOSITE[last] || queue.length >= 3) return queue as Dir[];
  return [...queue, d];
}

/** A swipe's direction, or null for a tap / a short drag. */
export function swipeDir(dx: number, dy: number, threshold = 24): Dir | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return null;
  return ax > ay ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

export type SnakePhase = 'ready' | 'playing' | 'over';

export interface Token extends Cell {
  pitch: number;
  /** a black key (drawn with a sharp sign) */
  sharp: boolean;
}

export interface SnakeState {
  phase: SnakePhase;
  /** head first */
  body: Cell[];
  dir: Dir;
  queue: Dir[];
  token: Token | null;
  score: number;
  /** cells still to grow */
  grow: number;
  /** ms since the last move */
  acc: number;
  rng: Rng;
  tune: MelodyCursor;
  /** the last note eaten (for the key light-up) and the move count then */
  lastPitch: number | null;
  moves: number;
  lastPitchMove: number;
}

export function newSnake(cfg: SnakeConfig, seed: number, tune = 1): SnakeState {
  const y = Math.floor(cfg.rows / 2);
  const x = Math.floor(cfg.cols / 3);
  const s: SnakeState = {
    phase: 'ready',
    body: [
      { x, y },
      { x: x - 1, y },
      { x: x - 2, y },
    ],
    dir: 'right',
    queue: [],
    token: null,
    score: 0,
    grow: 0,
    acc: 0,
    rng: makeRng(seed),
    tune: melodyCursor(tune),
    lastPitch: null,
    moves: 0,
    lastPitchMove: -100,
  };
  placeToken(s, cfg);
  return s;
}

const occupied = (s: SnakeState, x: number, y: number) => s.body.some((c) => c.x === x && c.y === y);

/**
 * Put the next note of the tune on the board: in its key's column on a free row, else on any free
 * cell (null when the board is full).
 */
export function placeToken(s: SnakeState, cfg: SnakeConfig): void {
  const pitch = nextNotePeek(s.tune);
  const col = pitchColumn(pitch, cfg);
  const head = s.body[0];
  const free: number[] = [];
  for (let y = 0; y < cfg.rows; y++) {
    // not right in front of the head: a free point is no fun
    if (!occupied(s, col, y) && !(col === head.x && Math.abs(y - head.y) <= 1)) free.push(y);
  }
  if (free.length) {
    s.token = { x: col, y: free[randomInt(s.rng, free.length)], pitch, sharp: isBlackKey(pitch) };
    return;
  }
  const cells: Cell[] = [];
  for (let y = 0; y < cfg.rows; y++) for (let x = 0; x < cfg.cols; x++) if (!occupied(s, x, y)) cells.push({ x, y });
  if (!cells.length) {
    s.token = null;
    return;
  }
  const c = cells[randomInt(s.rng, cells.length)];
  s.token = { ...c, pitch, sharp: isBlackKey(pitch) };
}

function nextNotePeek(c: MelodyCursor): number {
  return nextNote(c).pitch;
}

/** Start a run from the ready screen (a key, tap or swipe). */
export function startSnake(s: SnakeState): void {
  if (s.phase === 'ready') s.phase = 'playing';
}

/** Steer (queued; applied one per move). Starts the run from the ready screen. */
export function steer(s: SnakeState, d: Dir): void {
  if (s.phase === 'over') return;
  startSnake(s);
  s.queue = enqueueDir(s.queue, s.dir, d);
}

export type SnakeEvent = 'move' | 'eat' | 'crash';

const STEP: Record<Dir, Cell> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** One move. Returns what happened. */
export function moveSnake(s: SnakeState, cfg: SnakeConfig): SnakeEvent {
  const d = s.queue.length ? s.queue.shift()! : s.dir;
  s.dir = d;
  const head = s.body[0];
  const nx = head.x + STEP[d].x;
  const ny = head.y + STEP[d].y;
  s.moves++;
  // the tail moves out of its cell this move unless the line grows
  const tailLeaves = s.grow === 0;
  const hitsSelf = s.body.some((c, i) => c.x === nx && c.y === ny && !(tailLeaves && i === s.body.length - 1));
  if (nx < 0 || ny < 0 || nx >= cfg.cols || ny >= cfg.rows || hitsSelf) {
    s.phase = 'over';
    s.queue = [];
    return 'crash';
  }
  // reuse the tail cell as the new head when not growing (no garbage per move)
  let cell: Cell;
  if (tailLeaves) cell = s.body.pop()!;
  else {
    cell = { x: 0, y: 0 };
    s.grow--;
  }
  cell.x = nx;
  cell.y = ny;
  s.body.unshift(cell);
  if (s.token && s.token.x === nx && s.token.y === ny) {
    s.score++;
    s.grow++;
    const n = nextNote(s.tune);
    s.tune = n.cursor;
    s.lastPitch = n.pitch;
    s.lastPitchMove = s.moves;
    placeToken(s, cfg);
    return 'eat';
  }
  return 'move';
}

/** Advance by `dtMs` of real time (at most 250 ms at once). Events are pushed to `out`. */
export function stepSnake(s: SnakeState, cfg: SnakeConfig, dtMs: number, out: SnakeEvent[]): void {
  const dt = Math.min(250, Math.max(0, dtMs));
  if (s.phase !== 'playing') return;
  s.acc += dt;
  for (let i = 0; i < 4 && s.phase === 'playing'; i++) {
    const interval = snakeInterval(s.score, cfg);
    if (s.acc < interval) break;
    s.acc -= interval;
    out.push(moveSnake(s, cfg));
  }
  if (s.acc > snakeInterval(s.score, cfg)) s.acc = 0;
}
