/**
 * Repairs the sheet-editing data of a song read from storage or a project file (never throws): a
 * damaged grid lock drops the whole `song.sheet` and every pin (the sheet is then generated as for
 * an older song); a damaged pin is dropped on its own. Run by getSong and importProject.
 */
import { ARTICULATIONS, DYNAMIC_VALUES, type Articulation, type Note, type SheetMark, type Song, type SongSheet, type TempoUnit } from '../music/types';

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
  const list = <T extends { pos: number }>(raw: unknown, ok: (x: Record<string, unknown>) => T | null): T[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const byPos = new Map<number, T>();
    for (const r of raw.slice(0, 5000)) {
      if (!r || typeof r !== 'object' || !isInt((r as { pos?: unknown }).pos)) continue;
      const v = ok(r as Record<string, unknown>);
      if (v) byPos.set(v.pos, v); // the last at a position wins
    }
    const a = [...byPos.values()].sort((x, y) => x.pos - y.pos).slice(0, 500);
    return a.length ? a : undefined;
  };
  const keys = list(s.keys, (k) => (isInt(k.fifths, -7, 7) && (k.mode === 'major' || k.mode === 'minor') ? { pos: k.pos as number, fifths: k.fifths, mode: k.mode as 'major' | 'minor' } : null));
  if (keys) out.keys = keys;
  const meters = list(s.meters, (k) =>
    isInt(k.beatsPerBar, 1, 16) && (k.beatUnit === 2 || k.beatUnit === 4 || k.beatUnit === 8) ? { pos: k.pos as number, beatsPerBar: k.beatsPerBar, beatUnit: k.beatUnit as 2 | 4 | 8 } : null,
  );
  if (meters) out.meters = meters;
  const units: TempoUnit[] = ['q', 'h', 'e', 'q.'];
  const tempos = list(s.tempos, (k) => {
    if (!isNum(k.bpm) || k.bpm < 20 || k.bpm > 400 || !units.includes(k.unit as TempoUnit)) return null;
    const text = typeof k.text === 'string' ? cleanText(k.text, 40) : '';
    return { pos: k.pos as number, bpm: k.bpm, unit: k.unit as TempoUnit, ...(text ? { text } : {}), retimed: k.retimed === true };
  });
  if (tempos) out.tempos = tempos;
  return out;
}

/** Text without control characters, trimmed and capped. */
export const cleanText = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, max);

/** A valid marking (a copy), or null. Slurs need both notes, on the same hand (`hands`: id → hand). */
export function validMark(raw: unknown, hands: Map<number, string>): SheetMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id || m.id.length > 40) return null;
  const id = m.id;
  const staff3 = (x: unknown): x is 0 | 1 | 2 => x === 0 || x === 1 || x === 2;
  switch (m.kind) {
    case 'dyn':
      return isInt(m.pos) && staff3(m.staff) && DYNAMIC_VALUES.includes(m.value as never) ? { id, kind: 'dyn', pos: m.pos, staff: m.staff, value: m.value as never } : null;
    case 'wedge':
      return isInt(m.pos) && isInt(m.end) && m.end > m.pos && staff3(m.staff) && (m.dir === 'cresc' || m.dir === 'dim') ? { id, kind: 'wedge', pos: m.pos, end: m.end, staff: m.staff, dir: m.dir } : null;
    case 'text': {
      if (!isInt(m.pos) || (m.staff !== 1 && m.staff !== 2) || typeof m.text !== 'string') return null;
      const text = cleanText(m.text, 80);
      if (!text) return null;
      const style = m.style === 'italic' || m.style === 'bold' ? m.style : undefined;
      return { id, kind: 'text', pos: m.pos, staff: m.staff, text, above: m.above !== false, ...(style ? { style } : {}) };
    }
    case 'slur': {
      if (!isNum(m.from) || !isNum(m.to) || m.from === m.to) return null;
      const a = hands.get(m.from);
      if (!a || a !== hands.get(m.to)) return null;
      return { id, kind: 'slur', from: m.from, to: m.to, ...(m.below === true ? { below: true } : {}) };
    }
  }
  return null;
}

/** A note's sheet fields repaired in place (pin only with a lock). */
function cleanNote(n: Note, sheet: SongSheet | null): void {
  if ('pin' in n) {
    if (!sheet || !validPin(n.pin)) delete n.pin;
    else n.pin = { on: n.pin!.on, off: n.pin!.off, t: n.pin!.t, d: n.pin!.d };
  }
  if ('finger' in n && !isInt(n.finger, 1, 5)) delete n.finger;
  if ('art' in n) {
    const a = Array.isArray(n.art) ? [...new Set(n.art.filter((x): x is Articulation => ARTICULATIONS.includes(x as Articulation)))] : [];
    if (a.length) n.art = a;
    else delete n.art;
  }
  if ('artBase' in n) {
    const b = n.artBase as Record<string, unknown> | undefined;
    const out: { dur?: number; vel?: number } = {};
    if (b && typeof b === 'object') {
      if (isNum(b.dur) && b.dur > 0) out.dur = b.dur;
      if (isNum(b.vel) && b.vel >= 0 && b.vel <= 1) out.vel = b.vel;
    }
    if (out.dur !== undefined || out.vel !== undefined) n.artBase = out;
    else delete n.artBase;
  }
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
      for (const n of list) if (n && typeof n === 'object') cleanNote(n as Note, sheet);
    }
    for (const a of Object.values(song.arrangements ?? {})) {
      if (!a || typeof a !== 'object') continue;
      const arr = a as Song['arrangements']['hard'];
      if ('marks' in arr) {
        const hands = new Map<number, string>();
        if (Array.isArray(arr.notes)) for (const n of arr.notes) if (n && typeof n === 'object' && isNum(n.id)) hands.set(n.id, n.hand);
        const ids = new Set<string>();
        const marks: SheetMark[] = [];
        if (Array.isArray(arr.marks))
          for (const raw of arr.marks.slice(0, 20000)) {
            const mk = validMark(raw, hands);
            if (mk && !ids.has(mk.id)) {
              ids.add(mk.id);
              marks.push(mk);
            }
          }
        if (marks.length) arr.marks = marks;
        else delete arr.marks;
      }
      if ('showPedal' in arr && arr.showPedal !== true) delete arr.showPedal;
      if ('pedalEdited' in arr && arr.pedalEdited !== true) delete arr.pedalEdited;
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
