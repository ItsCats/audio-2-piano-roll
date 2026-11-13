/**
 * Repairs the sheet-editing data of a song read from storage or a project file (never throws): a
 * damaged grid lock drops the whole `song.sheet` and every pin (the sheet is then generated as for
 * an older song); a damaged pin is dropped on its own. Run by getSong and importProject.
 */
import type { Note, Song, SongSheet } from '../music/types';

const isInt = (x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The sheet data when it is valid, else null. */
export function validSheet(sheet: unknown): SongSheet | null {
  if (!sheet || typeof sheet !== 'object') return null;
  const s = sheet as Partial<SongSheet>;
  const g = s.grid;
  if (s.v !== 1 || !g || typeof g !== 'object') return null;
  const beats = g.beats;
  if (!Array.isArray(beats) || beats.length < 2 || beats.length > 200000) return null;
  for (let i = 0; i < beats.length; i++) if (!isNum(beats[i]) || (i > 0 && !(beats[i] > beats[i - 1]))) return null;
  if (!isInt(g.db, 0, beats.length - 1) || !isInt(g.pickup, 0, 10000) || !isNum(g.originQ) || !isNum(g.bpm) || g.bpm < 20 || g.bpm > 400) return null;
  if (!isInt(g.beatsPerBar, 1, 16) || (g.beatUnit !== 2 && g.beatUnit !== 4 && g.beatUnit !== 8)) return null;
  const out: SongSheet = {
    v: 1,
    grid: { beats: [...beats], db: g.db, bpm: g.bpm, beatsPerBar: g.beatsPerBar, beatUnit: g.beatUnit, originQ: g.originQ, pickup: g.pickup },
  };
  if (isInt(s.bars, 1, 10000)) out.bars = s.bars;
  return out;
}

function validPin(p: unknown): p is NonNullable<Note['pin']> {
  if (!p || typeof p !== 'object') return false;
  const { on, off, t, d } = p as Record<string, unknown>;
  return isInt(on) && isInt(off) && (off as number) > (on as number) && isNum(t) && isNum(d);
}

/** Repairs `song` in place (and returns it). */
export function sanitizeSheetData<T extends Song>(song: T): T {
  try {
    const raw = (song as { sheet?: unknown }).sheet;
    const sheet = raw === undefined ? null : validSheet(raw);
    if (sheet) song.sheet = sheet;
    else delete song.sheet;
    const lists: unknown[] = [song.base, ...Object.values(song.arrangements ?? {}).map((a) => (a as { notes?: unknown })?.notes)];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const n of list) {
        if (!n || typeof n !== 'object' || !('pin' in n)) continue;
        if (!sheet || !validPin((n as Note).pin)) delete (n as Note).pin;
        else {
          const p = (n as Note).pin!;
          (n as Note).pin = { on: p.on, off: p.off, t: p.t, d: p.d };
        }
      }
    }
  } catch {
    try {
      delete song.sheet;
    } catch {
      /* frozen: leave it */
    }
  }
  return song;
}
