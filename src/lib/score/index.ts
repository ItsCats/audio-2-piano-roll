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
import { unzipSync, strFromU8 } from 'fflate';
import type { KeyInfo, Note, PedalRange, TempoInfo } from '../music/types';
import { assignHands } from '../music/hands';
import { newNoteId, sortNotes } from '../music/cleanup';
import { PIANO_MAX, PIANO_MIN, prefersFlats } from '../music/theory';
import type { ScoreIR } from './ir';
import { musicXmlToIR } from './musicxml';
import { mscxToIR } from './mscx';
import { perform, qToSec, type Performance } from './perform';
import { decodeXmlBytes, parseXml, child, childrenNamed } from './xml';

export { musicXmlToIR } from './musicxml';
export { mscxToIR } from './mscx';
export { perform } from './perform';
export type { ScoreIR } from './ir';

export const SCORE_EXTENSIONS = ['musicxml', 'xml', 'mxl', 'mscz', 'mscx'];
/** Largest score file accepted (compressed or not). */
export const MAX_SCORE_BYTES = 30 * 1024 * 1024;

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
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => !f.name.endsWith('/') && f.originalSize < 200 * 1024 * 1024 && !/\.(png|jpe?g|gif|pdf|ogg|wav|mp3)$/i.test(f.name) });
    } catch {
      throw new ScoreImportError('This compressed sheet-music file is damaged and could not be opened.');
    }
    const mscx = Object.keys(files).find((f) => /\.mscx$/i.test(f) && !f.includes('/'));
    if (e === 'mscz' || (mscx && e !== 'mxl')) {
      if (!mscx) throw new ScoreImportError(museScoreHelp('This MuseScore file has no score inside.'));
      return fromMscx(decodeXmlBytes(files[mscx]), name, 'mscz');
    }
    const root = rootFile(files);
    if (!root) throw new ScoreImportError('No MusicXML score was found inside this .mxl file.');
    return importMusicXml(decodeXmlBytes(files[root]), { fileName: name, format: 'mxl' });
  }
  const text = decodeXmlBytes(bytes);
  if (e === 'mscx' || /<museScore[\s>]/.test(text.slice(0, 2000))) return fromMscx(text, name, 'mscx');
  if (!/<score-(partwise|timewise)[\s>]/.test(text)) {
    if (e === 'mxl') throw new ScoreImportError('This .mxl file is damaged (it is not a compressed MusicXML file).');
    throw new ScoreImportError('This file is not MusicXML sheet music.');
  }
  return importMusicXml(text, { fileName: name, format: 'musicxml' });
}

/** The score inside an .mxl: META-INF/container.xml's first rootfile, else the first .musicxml/.xml file. */
function rootFile(files: Record<string, Uint8Array>): string | null {
  const container = files['META-INF/container.xml'];
  if (container) {
    try {
      const c = parseXml(strFromU8(container));
      const rootfiles = childrenNamed(child(c, 'rootfiles'), 'rootfile');
      const xmlRoot = rootfiles.find((r) => !r.attrs['media-type'] || /musicxml|xml/.test(r.attrs['media-type'])) ?? rootfiles[0];
      const p = xmlRoot?.attrs['full-path'];
      if (p && files[p]) return p;
    } catch {
      /* fall through */
    }
  }
  return Object.keys(files).find((f) => !f.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(f)) ?? null;
}

function museScoreHelp(reason: string): string {
  return `${reason} In MuseScore, choose File → Export → MusicXML, then import that file here.`;
}

function fromMscx(text: string, fileName: string, format: ScoreFormat): ParsedScore {
  let ir: ScoreIR;
  try {
    ir = mscxToIR(text);
  } catch (err) {
    throw new ScoreImportError(museScoreHelp(err instanceof ScoreImportError ? err.message : 'This MuseScore file could not be read.'));
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

  // ---- hands: piano staves say which hand; other instruments are split by pitch
  const grand = (part: number) => ir.parts[part].keyboard && ir.parts[part].staves >= 2;
  const fromStaves = raw.every((r) => grand(r.pn.part));
  const usedParts = [...new Set(raw.map((r) => r.pn.part))];
  for (const r of raw) if (grand(r.pn.part)) r.note.hand = r.pn.staff >= 2 ? 'L' : 'R';
  let notes = raw.map((r) => r.note);
  if (!fromStaves) {
    const others = raw.filter((r) => !grand(r.pn.part));
    const mono = usedParts.length === 1 && maxPolyphony(others.map((r) => r.note)) <= 1;
    if (mono) {
      const avg = others.reduce((s, r) => s + r.note.midi, 0) / others.length;
      for (const r of others) r.note.hand = avg < 55 ? 'L' : 'R';
    } else {
      const assigned = assignHands(others.map((r) => r.note), Math.max(...others.map((r) => r.note.start + r.note.dur)));
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
  const lastNote = Math.max(...notes.map((n) => n.start + n.dur));
  const duration = Math.max(sec(endQ), lastNote);
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
    bpm: Math.round((60 / perf.tempo.spq[0]) * (meter.beatUnit / 4) * 10) / 10,
    beats,
    beatsPerBar: meter.beatsPerBar,
    beatUnit: meter.beatUnit,
    downbeatIndex,
    confidence: 1,
    source: 'midi',
  };

  const k0 = ir.measures.find((m) => m.key)?.key;
  const key = k0 ? keyFromSignature(k0.fifths, k0.mode) : undefined;
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
