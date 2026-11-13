/**
 * When the import card offers "Play a game while you wait", and the games' own small settings
 * (best scores, sound on/off) in localStorage under their own keys.
 */

/** an import expected to take longer than this offers a game */
export const OFFER_AFTER_SEC = 20;

export interface OfferJob {
  stage: string;
  kind: string;
  sheet?: 'pdf' | 'photo';
  startedAt: number;
  rate?: { etaSec?: number; at?: number };
}

/**
 * Offer a game while an import runs that takes (or, from its measured speed, will take) more than
 * OFFER_AFTER_SEC: audio imports and the sheet-music reader. MIDI files, MusicXML and the demo are
 * done in a moment.
 */
export function offerGame(job: OfferJob | null, now: number): boolean {
  if (!job || job.stage === 'done' || job.stage === 'error') return false;
  if (job.kind === 'midi' || job.kind === 'demo' || (job.kind === 'score' && !job.sheet)) return false;
  const elapsed = (now - job.startedAt) / 1000;
  if (elapsed >= OFFER_AFTER_SEC) return true;
  const r = job.rate;
  if (r?.etaSec !== undefined && r.at !== undefined) {
    const left = r.etaSec - (now - r.at) / 1000;
    return elapsed + left >= OFFER_AFTER_SEC && left >= 5;
  }
  return false;
}

export type GameId = 'note-hopper' | 'key-snake';

const BEST_KEY: Record<GameId, string> = {
  'note-hopper': 'piano2vision-game-best-note-hopper',
  'key-snake': 'piano2vision-game-best-key-snake',
};
const SOUND_KEY = 'piano2vision-game-sound';

export function loadBest(game: GameId): number {
  try {
    const n = Number(localStorage.getItem(BEST_KEY[game]));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Store a score if it beats the best; returns the best now. */
export function saveBest(game: GameId, score: number): number {
  const best = loadBest(game);
  if (score <= best) return best;
  try {
    localStorage.setItem(BEST_KEY[game], String(score));
  } catch {
    /* private mode / storage full: the best score just isn't kept */
  }
  return score;
}

export function loadSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveSoundOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* not kept */
  }
}
