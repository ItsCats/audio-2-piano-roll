/**
 * Sheet-music import: score files (MusicXML .musicxml/.xml, compressed .mxl, MuseScore
 * .mscz/.mscx) → the notes, pedal, beat grid and key of a Song. Pure TS (no DOM), so it runs in
 * Node tests and could run in a worker.
 *
 * Entry points:
 * - readScoreFile(name, bytes): any supported score file.
 * - importMusicXml(text, meta): MusicXML text. This is the interface the future PDF / photo
 *   recognition step (OMR) calls with the MusicXML it produces; songFromScore (lib/songs.ts) then
 *   builds the Song exactly like for a score file.
 */
import { unzipSync } from 'fflate';
import type { KeyInfo, Note, PedalRange, TempoInfo } from '../music/types';
import { assignHands } from '../music/hands';
import { newNoteId, sortNotes } from '../music/cleanup';
import { PIANO_MAX, PIANO_MIN, prefersFlats } from '../music/theory';
import type { ScoreIR } from './ir';
import { musicXmlToIR } from './musicxml';
import { MscxError, mscxToIR } from './mscx';
import { perform, qToSec, type Performance } from './perform';
import { decodeXmlBytes, parseXml, child, childrenNamed } from './xml';

export { musicXmlToIR } from './musicxml';
export { mscxToIR } from './mscx';
export { perform } from './perform';
export type { ScoreIR } from './ir';

export const SCORE_EXTENSIONS = ['musicxml', 'xml', 'mxl', 'mscz', 'mscx'];
/** Largest score file accepted (compressed or not). */
export const MAX_SCORE_BYTES = 30 * 1024 * 1024;
/** Longest performance imported (repeats played out); anything after it is left out with a warning. */
export const MAX_SCORE_SECONDS = 60 * 60;
/** Largest score inside a .mxl / .mscz after decompression. */
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;

export type ScoreFormat = 'musicxml' | 'mxl' | 'mscz' | 'mscx';

export interface ParsedScore {
  title?: string;
  composer?: string;
  format: ScoreFormat;
  notes: Note[];
  pedal: PedalRange[];
  tempo: TempoInfo;
  key?: KeyInfo;
  duration: number;
  /** Plain-language notes for the user (things left out, combined or approximated). */
  warnings: string[];
  /** The hands come from the score's staves (Hard keeps them as written). */
  handsKnown: boolean;
  /** Number of written measures and of measures played (repeats unrolled). */
  measures: { written: number; played: number };
}

export interface ScoreMeta {
  fileName?: string;
  /** Format to report (default 'musicxml'). */
  format?: ScoreFormat;
}

/** Thrown for files that are valid but can't be read here; `message` is shown to the user as is. */
export class ScoreImportError extends Error {}

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';

/** Is this file name a score file this importer reads? */
export function isScoreFileName(name: string): boolean {
  return SCORE_EXTENSIONS.includes(ext(name));
}

/** Reads any supported score file. */
export function readScoreFile(name: string, bytes: Uint8Array): ParsedScore {
  if (bytes.length > MAX_SCORE_BYTES) throw new ScoreImportError('This sheet-music file is too large (max 30 MB).');
  if (!bytes.length) throw new ScoreImportError('This file is empty.');
  const e = ext(name);
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  if (zipped) {
    // List the entries first, then decompress only the score itself (plus META-INF/container.xml,
    // which names it): a zip can hold many large files.
    const entries = new Map<string, number>();
    let files: Record<string, Uint8Array>;
    const unzip = (want: (name: string) => boolean) => {
      try {
        return unzipSync(bytes, {
          filter: (f) => {
            if (f.name.endsWith('/')) return false;
            entries.set(f.name, f.originalSize);
            return want(f.name) && f.originalSize <= MAX_UNZIPPED_BYTES;
          },
        });
      } catch {
        throw new ScoreImportError('This compressed sheet-music file is damaged and could not be opened.');
      }
    };
    files = unzip((n) => n === 'META-INF/container.xml');
    const mscx = [...entries.keys()].find((f) => /\.mscx$/i.test(f) && !f.includes('/'));
    let target: string | null;
    let asMscz = false;
    if (e === 'mscz' || (mscx && e !== 'mxl')) {
      if (!mscx) throw new ScoreImportError(museScoreHelp('This MuseScore file has no score inside.'));
      target = mscx;
      asMscz = true;
    } else {
      target = rootFile(files['META-INF/container.xml'], entries);
      if (!target) throw new ScoreImportError('No MusicXML score was found inside this .mxl file.');
    }
    if ((entries.get(target) ?? 0) > MAX_UNZIPPED_BYTES) throw new ScoreImportError('The score inside this file is too large (max 50 MB).');
    if (!files[target]) files = unzip((n) => n === target);
    const data = files[target];
    if (!data) throw new ScoreImportError('This compressed sheet-music file is damaged and could not be opened.');
    if (asMscz) return fromMscx(decodeXmlBytes(data), name, 'mscz');
    return importMusicXml(decodeXmlBytes(data), { fileName: name, format: 'mxl' });
  }
  const text = decodeXmlBytes(bytes);
  if (e === 'mscx' || /<museScore[\s>]/.test(text.slice(0, 2000))) return fromMscx(text, name, 'mscx');
  if (!/<score-(partwise|timewise)[\s>]/.test(text)) {
    if (e === 'mxl') throw new ScoreImportError('This .mxl file is damaged (it is not a compressed MusicXML file).');
    throw new ScoreImportError('This file is not MusicXML sheet music.');
  }
  return importMusicXml(text, { fileName: name, format: 'musicxml' });
}

/** The score inside an .mxl: META-INF/container.xml's first MusicXML rootfile, else the first .musicxml/.xml file. */
function rootFile(container: Uint8Array | undefined, entries: Map<string, number>): string | null {
  if (container) {
    try {
      const c = parseXml(decodeXmlBytes(container));
      const rootfiles = childrenNamed(child(c, 'rootfiles'), 'rootfile');
      const xmlRoot = rootfiles.find((r) => !r.attrs['media-type'] || /musicxml|xml/.test(r.attrs['media-type'])) ?? rootfiles[0];
      const p = xmlRoot?.attrs['full-path'];
      if (p && entries.has(p)) return p;
    } catch {
      /* fall through */
    }
  }
  return [...entries.keys()].find((f) => !f.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(f)) ?? null;
}

function museScoreHelp(reason: string): string {
  return `${reason} In MuseScore, choose File → Export → MusicXML, then import that file here.`;
}

function fromMscx(text: string, fileName: string, format: ScoreFormat): ParsedScore {
  let ir: ScoreIR;
  try {
    ir = mscxToIR(text);
  } catch (err) {
    throw new ScoreImportError(museScoreHelp(err instanceof MscxError ? err.message : 'This MuseScore file could not be read.'));
  }
  return fromIR(ir, { fileName, format });
}

/**
 * MusicXML text → the parts of a Song. The PDF / photo step (OMR) calls this with the MusicXML it
 * recognised and passes the result to songFromScore (lib/songs.ts).
 */
export function importMusicXml(text: string, meta: ScoreMeta = {}): ParsedScore {
  let ir: ScoreIR;
  try {
    ir = musicXmlToIR(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ScoreImportError(/^This /.test(msg) ? msg : `This MusicXML file could not be read (${msg}).`);
  }
  return fromIR(ir, { format: 'musicxml', ...meta });
}

// ---------------------------------------------------------------- IR → song parts

/** Beat grid of a meter: the song's beat unit and bar length in those units. */
function meterOf(beats: number, beatType: number): { beatsPerBar: number; beatUnit: 2 | 4 | 8 } {
  if ((beatType === 2 || beatType === 4 || beatType === 8) && Number.isInteger(beats) && beats >= 1 && beats <= 16) return { beatsPerBar: beats, beatUnit: beatType };
  const q = (beats * 4) / beatType;
  if (beatType === 1 && beats * 2 <= 16) return { beatsPerBar: beats * 2, beatUnit: 2 };
  if (Number.isInteger(q) && q >= 1 && q <= 16) return { beatsPerBar: q, beatUnit: 4 };
  const e = q * 2;
  if (Number.isInteger(e) && e >= 1 && e <= 16) return { beatsPerBar: e, beatUnit: 8 };
  return { beatsPerBar: 4, beatUnit: 4 };
}

const MAJOR_TONIC = (fifths: number) => (((fifths * 7) % 12) + 12) % 12;
const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export function keyFromSignature(fifths: number, mode: 'major' | 'minor'): KeyInfo {
  const tonic = mode === 'minor' ? (MAJOR_TONIC(fifths) + 9) % 12 : MAJOR_TONIC(fifths);
  const flats = fifths < 0 || (fifths === 0 && prefersFlats(tonic, mode));
  return { tonic, mode, name: `${(flats ? NAMES_FLAT : NAMES_SHARP)[tonic]} ${mode}`, confidence: 1, fifths };
}

export interface ScoreTiming {
  perf: Performance;
  /** Length of the pickup (incomplete first measure) in quarters, 0 when none. */
  pickup: number;
  /** Silence added before a pickup so the beat grid starts on a beat (quarters). */
  lead: number;
  /** Song seconds of a performance position in quarters. */
  sec: (q: number) => number;
}

/** The performance and its clock (exported for tests). */
export function scoreTiming(ir: ScoreIR): ScoreTiming {
  const perf = perform(ir);
  const first = ir.measures[perf.order[0]?.index ?? 0];
  const { beatUnit } = first ? meterOf(first.beats, first.beatType) : { beatUnit: 4 as const };
  const beatQ = 4 / beatUnit;
  const pickup = first && perf.order.length > 1 && first.length < (first.beats * 4) / first.beatType - 1e-6 ? first.length : 0;
  const lead = pickup ? Math.ceil(pickup / beatQ - 1e-6) * beatQ - pickup : 0;
  const spq0 = perf.tempo.spq[0];
  const leadSec = lead * spq0;
  const sec = (q: number) => (q < 0 ? leadSec + q * spq0 : leadSec + qToSec(perf.tempo, q));
  return { perf, pickup, lead, sec };
}

export function fromIR(ir: ScoreIR, meta: ScoreMeta = {}): ParsedScore {
  const warnings = [...ir.warnings];
  const playable = ir.parts.filter((p) => !p.ignored);
  if (!ir.measures.length || !playable.length) throw new ScoreImportError('This sheet music has no notes to play.');
  const { perf, pickup, lead, sec } = scoreTiming(ir);
  warnings.push(...perf.warnings);
  if (!perf.notes.length) throw new ScoreImportError('This sheet music has no notes to play.');

  // ---- notes
  let shifted = 0;
  const raw = perf.notes.map((pn) => {
    let midi = pn.midi;
    while (midi < PIANO_MIN) midi += 12;
    while (midi > PIANO_MAX) midi -= 12;
    if (midi !== pn.midi) shifted++;
    const start = sec(pn.on);
    return { pn, note: { id: newNoteId(), midi, start, dur: Math.max(0.02, sec(pn.off) - start), vel: pn.vel, hand: 'R' as Note['hand'] } };
  });
  if (shifted) warnings.push(`${shifted} note${shifted === 1 ? ' was' : 's were'} outside the piano’s range and moved by an octave.`);

  // ---- hands: piano staves say which hand; other instruments are split by pitch. A part on two
  // staves counts as a piano when it is named like one or is the only part with notes (recognised
  // sheet music and non-English scores often have no usable part name).
  const usedParts = [...new Set(raw.map((r) => r.pn.part))];
  const grand = (part: number) => ir.parts[part].staves >= 2 && (ir.parts[part].keyboard || usedParts.length === 1);
  const fromStaves = raw.every((r) => grand(r.pn.part));
  for (const r of raw) if (grand(r.pn.part)) r.note.hand = r.pn.staff >= 2 ? 'L' : 'R';
  let notes = raw.map((r) => r.note);
  if (!fromStaves) {
    const others = raw.filter((r) => !grand(r.pn.part));
    const mono = usedParts.length === 1 && maxPolyphony(others.map((r) => r.note)) <= 1;
    if (mono) {
      const avg = others.reduce((s, r) => s + r.note.midi, 0) / others.length;
      for (const r of others) r.note.hand = avg < 55 ? 'L' : 'R';
    } else {
      const assigned = assignHands(others.map((r) => r.note), lastEnd(others.map((r) => r.note)));
      const byId = new Map(assigned.map((n) => [n.id, n.hand]));
      for (const r of others) r.note.hand = byId.get(r.note.id) ?? r.note.hand;
    }
    if (usedParts.length > 1) {
      const names = usedParts.map((p) => ir.parts[p].name).filter(Boolean);
      warnings.push(
        `This score has ${usedParts.length} parts${names.length ? ` (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})` : ''}. They were combined into one piano part${
          usedParts.some(grand) ? ', with the piano’s hands as written and the other notes split between the hands by pitch' : ' and split between the hands by pitch'
        }.`,
      );
    }
  }
  notes = dedupe(notes);

  // ---- pedal
  const pedal: PedalRange[] = perf.pedal.map((p) => ({ start: sec(p.on), end: sec(p.off) })).filter((p) => p.end - p.start > 0.01);

  // ---- beat grid (in the first measure's meter), downbeat after the pickup
  const firstM = ir.measures[perf.order[0].index];
  const meter = meterOf(firstM.beats, firstM.beatType);
  const beatQ = 4 / meter.beatUnit;
  const barQ = meter.beatsPerBar * beatQ;
  const endQ = perf.measureStart[perf.measureStart.length - 1];
  const lastNote = lastEnd(notes);
  let duration = Math.max(sec(endQ), lastNote);
  if (duration > MAX_SCORE_SECONDS) {
    // a broken or extreme file (huge repeat counts or note lengths): keep the first hour
    notes = notes.filter((n) => n.start < MAX_SCORE_SECONDS - 0.05);
    for (const n of notes) n.dur = Math.min(n.dur, MAX_SCORE_SECONDS - n.start);
    for (let i = pedal.length - 1; i >= 0; i--) {
      if (pedal[i].start >= MAX_SCORE_SECONDS) pedal.splice(i, 1);
      else pedal[i].end = Math.min(pedal[i].end, MAX_SCORE_SECONDS);
    }
    if (!notes.length) throw new ScoreImportError('This sheet music has no notes to play in its first hour.');
    duration = Math.max(lastEnd(notes), Math.min(sec(endQ), MAX_SCORE_SECONDS));
    warnings.push('This sheet music plays for more than an hour, so only the first hour was imported.');
  }
  const beats: number[] = [];
  for (let k = 0; k < 100000; k++) {
    const t = sec(-lead + k * beatQ);
    beats.push(Math.round(t * 1e6) / 1e6);
    if (t > duration + 2) break;
  }
  const downbeatIndex = pickup ? Math.round((pickup + lead) / beatQ) : 0;
  // bar lines: the grid is regular; say where it stops matching the score's bars
  for (let k = 1; k < perf.order.length; k++) {
    const x = (perf.measureStart[k] - pickup) / barQ;
    if (Math.abs(x - Math.round(x)) > 1e-4) {
      warnings.push(
        `From bar ${ir.measures[perf.order[k].index].label}, the bar lines in the piano roll and in the sheet music view no longer match the original score (it changes time signature or has a shorter bar there). The notes are not affected.`,
      );
      break;
    }
  }
  const tempo: TempoInfo = {
    bpm: Math.round(perf.firstQpm * (meter.beatUnit / 4) * 10) / 10,
    beats,
    beatsPerBar: meter.beatsPerBar,
    beatUnit: meter.beatUnit,
    downbeatIndex,
    confidence: 1,
    source: 'midi',
  };

  const k0 = ir.measures.find((m) => m.key)?.key;
  const key = k0 ? keyFromSignature(k0.fifths, k0.mode) : undefined;
  if (k0 && ir.measures.some((m) => m.key && (m.key.fifths !== k0.fifths || m.key.mode !== k0.mode))) {
    warnings.push('This score changes key. The sheet music view uses the first key signature throughout; the notes are not affected.');
  }
  return {
    title: ir.title,
    composer: ir.composer,
    format: meta.format ?? 'musicxml',
    notes: sortNotes(notes),
    pedal,
    tempo,
    key,
    duration,
    warnings: [...new Set(warnings)],
    handsKnown: fromStaves,
    measures: { written: ir.measures.length, played: perf.order.length },
  };
}

/** End of the last note (a loop: spreading tens of thousands of notes into Math.max fails in Safari). */
function lastEnd(notes: Note[]): number {
  let end = 0;
  for (const n of notes) if (n.start + n.dur > end) end = n.start + n.dur;
  return end;
}

function maxPolyphony(notes: Note[]): number {
  const ev: [number, number][] = [];
  for (const n of notes) ev.push([n.start, 1], [n.start + n.dur - 1e-3, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return max;
}

/**
 * The same key can't sound twice: notes of the same pitch that start together (unisons between
 * voices or parts) become one (the longer), and a note still held when the key is struck again is
 * cut there.
 */
function dedupe(notes: Note[]): Note[] {
  const sorted = [...notes].sort((a, b) => a.midi - b.midi || a.start - b.start || b.dur - a.dur);
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.midi === n.midi) {
      if (Math.abs(n.start - prev.start) < 0.002) {
        prev.vel = Math.max(prev.vel, n.vel);
        continue;
      }
      if (prev.start + prev.dur > n.start) prev.dur = Math.max(0.02, n.start - prev.start);
    }
    out.push(n);
  }
  return out;
}
