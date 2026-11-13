// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * homr's page pipeline (homr/main.py process_image without title detection, homr --no-title):
 * page → crop / resize / CLAHE → segmentation → symbol boxes → staffs → notes → systems →
 * per staff: image → transformer → symbols → MusicXML. The neural networks are behind `HomrInfer`
 * (onnxruntime-web in the worker, see ort.ts), everything else is plain TypeScript.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { createBoundingEllipses, createRotatedBoundingBoxes, type RotatedBoundingBox } from './boxes';
import { dilate, structuringElement, threshold, type Img } from './cv';
import { median, MultiStaff, type Staff } from './model';
import { generateXml, joinPages } from './musicxml';
import { applyMask, argmaxClasses, autocrop, extractPatch, masksFromClasses, noiseMask, PatchMerger, patchOrigins, preprocess, resizeToTarget, WIN, type Predictions } from './preprocess';
import { breakWideFragments, detectStaff, estimateUnitSizeFromClefs } from './staffDetection';
import { encoderInput, prepareStaffImage, StaffRegions } from './staffImage';
import { addNotesToStaffs, combineNoteheadsWithStems, detectBarLines, findBracesBracketsAndGrandStaffLines, prepareBarLineImage, prepareBraceDotImage } from './symbols';
import { layoutOf, repairSystemsOfPage } from './systemRepair';
import { restoreUnmarkedTriplets } from './triplets';
import { EncodedSymbol, isUpperOrNoPosition, removeDuplicatedSymbols, VOCAB } from './vocabulary';
import { serialize, type El } from './xml';
import { MAX_ASPECT } from './page';
import type { PageErrorKind } from './protocol';

/** Token ids of one decoder step (rhythm, pitch, lift, articulation, slur, position). */
export type TokenIds = [number, number, number, number, number, number];

export interface HomrInfer {
  /** segmentation logits [n, 6, 320, 320] for n windows [n, 3, 320, 320] */
  segment(windows: Float32Array, n: number): Promise<Float32Array>;
  /** encoder + greedy decoder (with its KV cache) on one staff image [1, 1, 256, 1280]: token ids per step until EOS */
  transcribe(input: Float32Array, maxSteps: number, eosToken: number): Promise<TokenIds[]>;
}

export type Stage = 'segmenting' | 'finding-staffs' | 'reading';
export interface PageProgress {
  stage: Stage;
  /** 0..1 within the page */
  progress: number;
  staff?: number;
  staffs?: number;
}

/** Nothing to read on the page (the job goes on with the other pages). */
export class NoMusicError extends Error {
  constructor(
    message: string,
    readonly kind: PageErrorKind = 'no-music',
  ) {
    super(message);
  }
}

/** Optional intermediate results (tests, parity checks). */
export interface PageDump {
  crop?: [number, number, number, number];
  resized?: [number, number];
  classes?: Uint8Array;
  boxes?: Record<string, RotatedBoundingBox[]>;
  unit?: number;
  staffCount?: number;
  systems?: string[];
  staffImages?: Img[];
  /** per staff image: the staff's minX, minY, maxX, maxY, average unit size and grid points */
  staffExtents?: number[][];
  staffGrids?: number[][][];
  /** the staffs as detected (before braces and grand staffs): grid points x, y..., angle */
  detectedStaffs?: number[][][];
  tokens?: string[][];
  voices?: string[][];
}

const MAX_SEQ_LEN = 608;
const EOS = 2;
/** windows per segmentation run (Python homr: 8; fewer keeps the WASM heap small; low-memory mode: 1) */
export const SEG_BATCH = 2;

export interface ReadPageOptions {
  onProgress?: (p: PageProgress) => void;
  signal?: AbortSignal;
  dump?: PageDump;
  /** windows per segmentation run (default SEG_BATCH) */
  segBatch?: number;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Sheet-music reading cancelled', 'AbortError');
}

/** Segmentation of the CLAHE page, window by window (homr inference_segnet.inference). */
async function segment(pre: Img, infer: HomrInfer, opts: ReadPageOptions): Promise<Predictions> {
  const origins = patchOrigins(pre.w, pre.h);
  const merger = new PatchMerger(pre.w, pre.h);
  const plane = 3 * WIN * WIN;
  const cls = new Uint8Array(WIN * WIN);
  const batchSize = Math.max(1, opts.segBatch ?? SEG_BATCH);
  for (let i = 0; i < origins.length; i += batchSize) {
    checkAbort(opts.signal);
    const n = Math.min(batchSize, origins.length - i);
    const batch = new Float32Array(n * plane);
    for (let k = 0; k < n; k++) extractPatch(pre, origins[i + k][0], origins[i + k][1], batch.subarray(k * plane, (k + 1) * plane));
    const logits = await infer.segment(batch, n);
    for (let k = 0; k < n; k++) {
      argmaxClasses(logits, k * 6 * WIN * WIN, cls);
      merger.add(origins[i + k][0], origins[i + k][1], cls);
    }
    opts.onProgress?.({ stage: 'segmenting', progress: (i + n) / origins.length });
  }
  const classes = merger.classes();
  if (opts.dump) opts.dump.classes = classes;
  return masksFromClasses(classes, pre.w, pre.h);
}

export interface PageResult {
  /** symbols per voice (part) of the page */
  voices: EncodedSymbol[][];
  staffs: number;
  systems: number;
  /** the page's MusicXML tree */
  xml: El;
}

export interface FoundSystems {
  multi: MultiStaff[];
  /** the staffs (with their notes) before grouping */
  staffs: Staff[];
  /** the noise filter's mask (1 = keep), if it cleared part of the page */
  mask: Uint8Array | null;
}

/**
 * homr's image analysis on the segmentation (detect_staffs_in_image after get_predictions, plus
 * repair_systems): symbol boxes → staffs → notes → systems. Throws NoMusicError without staffs.
 */
export function findSystems(predIn: Predictions, dump?: PageDump): FoundSystems {
  // homr filter_predictions, make_lines_stronger
  const mask = noiseMask(predIn.staff);
  let pred = { ...predIn };
  if (mask) {
    pred = {
      ...pred,
      notehead: applyMask(pred.notehead, mask),
      symbols: applyMask(pred.symbols, mask),
      staff: applyMask(pred.staff, mask),
      clefsKeys: applyMask(pred.clefsKeys, mask),
      stemsRest: applyMask(pred.stemsRest, mask),
    };
  }
  pred.staff = threshold(dilate(pred.staff, structuringElement('ellipse', 1, 2)), 0.1, 1);

  // homr predict_symbols
  const noteheads = createBoundingEllipses(pred.notehead, [4, 4]);
  let fragments = createRotatedBoundingBoxes(pred.staff, { skipMerging: true, minSize: [5, 1], maxSize: [10000, 100] });
  const clefs = createRotatedBoundingBoxes(pred.clefsKeys, { minSize: [20, 40], maxSize: [1000, 1000] });
  const stems = createRotatedBoundingBoxes(pred.stemsRest);
  const barCandidates = createRotatedBoundingBoxes(prepareBarLineImage(pred.stemsRest), { skipMerging: true, minSize: [1, 5] });
  if (dump) dump.boxes = { noteheads: noteheads as unknown as RotatedBoundingBox[], staff_fragments: fragments, clefs_keys: clefs, stems_rest: stems, bar_lines: barCandidates };
  fragments = breakWideFragments(fragments);
  if (dump && dump.boxes) dump.boxes.staff_fragments_broken = fragments;

  const withStems = combineNoteheadsWithStems(noteheads, stems);
  let unit: number;
  if (withStems.length) unit = median(withStems.map((n) => n.notehead.size[1]));
  else {
    const u = estimateUnitSizeFromClefs(fragments, clefs);
    if (u === null) throw new NoMusicError('No noteheads or clefs found');
    unit = u;
  }
  if (dump) dump.unit = unit;
  const allHeads = withStems.map((n) => n.notehead);
  const allStems = withStems.map((n) => n.stem).filter((s): s is RotatedBoundingBox => s !== null);
  const barOrRests = barCandidates.filter((l) => !l.isOverlappingWithAny(allHeads) && !l.isOverlappingWithAny(allStems));
  const barLines = detectBarLines(barOrRests, unit);
  const staffs = detectStaff(pred.staff, fragments, clefs, barLines, pred.symbols);
  if (!staffs.length) throw new NoMusicError('No staffs found');
  if (dump) dump.staffCount = staffs.length;
  if (dump) dump.detectedStaffs = staffs.map((st) => st.grid.map((g) => [g.x, ...g.y, g.angle]));
  const braceDot = createRotatedBoundingBoxes(prepareBraceDotImage(pred.symbols, pred.staff), { skipMerging: true, maxSize: [100, -1] });
  addNotesToStaffs(staffs, withStems, pred.notehead);
  let multi = findBracesBracketsAndGrandStaffLines(staffs, braceDot);
  multi = repairSystemsOfPage(multi);
  if (dump) dump.systems = multi.map(layoutOf);
  return { multi, staffs, mask };
}

/** homr process_image on one page image (RGB or gray). */
export async function readPage(page: Img, infer: HomrInfer, opts: ReadPageOptions = {}): Promise<PageResult> {
  const dump = opts.dump;
  const cropped = autocrop(page);
  if (dump) dump.crop = [cropped.x, cropped.y, cropped.image.w, cropped.image.h];
  // not in homr: the width becomes 1920 px, so a long strip would become a huge image
  if (cropped.image.h > MAX_ASPECT * cropped.image.w) throw new NoMusicError('Image much taller than a page', 'too-tall');
  const resized = resizeToTarget(cropped.image);
  if (dump) dump.resized = [resized.w, resized.h];
  let pre = preprocess(resized);
  opts.onProgress?.({ stage: 'segmenting', progress: 0 });
  const pred = await segment(pre, infer, opts);
  checkAbort(opts.signal);
  opts.onProgress?.({ stage: 'finding-staffs', progress: 0 });

  const found = findSystems(pred, dump);
  if (found.mask) pre = applyMask(pre, found.mask);
  checkAbort(opts.signal);

  const voices = await parseStaffs(found.multi, pre, infer, opts);
  return { voices, staffs: found.staffs.length, systems: found.multi.length, xml: generateXml(voices) };
}

function slotsInLayout(row: string, layout: string): number[] | null {
  const matches: number[][] = [];
  const combos = (start: number, k: number, acc: number[]) => {
    if (acc.length === k) {
      if (acc.every((slot, i) => layout[slot] === row[i])) matches.push([...acc]);
      return;
    }
    for (let s = start; s < layout.length; s++) combos(s + 1, k, [...acc, s]);
  };
  combos(0, row.length, []);
  return matches.length === 1 ? matches[0] : null;
}

function assignParts(staffs: MultiStaff[]): number[][] | null {
  const layouts = [...new Set(staffs.map(layoutOf))];
  // max(set, key=len): the first longest in set order (insertion order is a stand-in for Python's set order)
  const largest = layouts.reduce((a, b) => (b.length > a.length ? b : a));
  if (layouts.some((l) => l.length === largest.length && l !== largest)) return null;
  const out: number[][] = [];
  for (const row of staffs) {
    const s = slotsInLayout(layoutOf(row), largest);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

function measureRestsLike(symbols: EncodedSymbol[], isGrandstaff: boolean): EncodedSymbol[] {
  const positions = isGrandstaff ? ['upper', 'lower'] : ['upper'];
  const out: EncodedSymbol[] = [];
  let inMeasure = false;
  for (const s of symbols) {
    if ((s.rhythm.startsWith('note') || s.rhythm.startsWith('rest')) && !inMeasure) {
      positions.forEach((p, i) => {
        if (i > 0) out.push(new EncodedSymbol('chord'));
        out.push(new EncodedSymbol('measureRest', '.', '.', '.', '.', p));
      });
      inMeasure = true;
    } else if (s.rhythm.includes('barline') || s.rhythm.includes('repeat')) {
      out.push(new EncodedSymbol(s.rhythm));
      inMeasure = false;
    }
  }
  return out;
}

function decodeTokens(ids: [number, number, number, number, number, number][]): EncodedSymbol[] {
  return ids.map(([r, p, l, a, s, pos]) => new EncodedSymbol(VOCAB.rhythm[r], VOCAB.pitch[p], VOCAB.lift[l], VOCAB.articulation[a], VOCAB.slur[s], VOCAB.position[pos]));
}

/** homr parse_staffs: every staff through the transformer, symbols per voice. */
async function parseStaffs(staffsIn: MultiStaff[], page: Img, infer: HomrInfer, opts: ReadPageOptions): Promise<EncodedSymbol[][]> {
  let staffs = staffsIn;
  let parts: number[][] = staffs.map((row) => row.staffs.map((_, i) => i));
  if (new Set(staffs.map((s) => s.staffs.length)).size > 1) {
    const assigned = assignParts(staffs);
    if (!assigned) {
      staffs = staffs.flatMap((s) => s.breakApart());
      parts = staffs.map(() => [0]);
    } else parts = assigned;
  }
  const nVoices = Math.max(...staffs.map((s) => s.staffs.length));
  const layout = layoutOf(staffs.find((r) => r.staffs.length === nVoices) as MultiStaff);
  const results = new Map<string, EncodedSymbol[]>();
  const regions = new StaffRegions(staffs);
  const total = parts.reduce((a, p) => a + p.length, 0);
  let done = 0;
  const input = new Float32Array(256 * 1280);
  for (let voice = 0; voice < nVoices; voice++) {
    for (let si = 0; si < staffs.length; si++) {
      if (!parts[si].includes(voice)) continue;
      checkAbort(opts.signal);
      const staff = staffs[si].staffs[parts[si].indexOf(voice)];
      const image = prepareStaffImage(staff, page, regions);
      if (opts.dump) {
        (opts.dump.staffImages ??= []).push(image);
        (opts.dump.staffExtents ??= []).push([staff.minX, staff.minY, staff.maxX, staff.maxY, staff.averageUnitSize]);
        (opts.dump.staffGrids ??= []).push(staff.grid.map((g) => [g.x, ...g.y, g.angle]));
      }
      // `staff`: the staff being read (1-based)
      opts.onProgress?.({ stage: 'reading', progress: done / total, staff: done + 1, staffs: total });
      let symbols = decodeTokens(await infer.transcribe(encoderInput(image, input), MAX_SEQ_LEN, EOS));
      if (!staff.isGrandstaff) symbols = symbols.filter((s) => isUpperOrNoPosition(s.position));
      if (opts.dump) (opts.dump.tokens ??= []).push(symbols.map(String));
      done++;
      opts.onProgress?.({ stage: 'reading', progress: done / total, staff: Math.min(done + 1, total), staffs: total });
      if (!symbols.length) continue;
      results.set(`${si},${voice}`, symbols);
    }
  }
  const voices: EncodedSymbol[][] = [];
  for (let voice = 0; voice < nVoices; voice++) {
    const forVoice: EncodedSymbol[] = [];
    parts.forEach((slots, si) => {
      let symbols = results.get(`${si},${voice}`);
      const shown = slots.filter((v) => results.has(`${si},${v}`)).map((v) => results.get(`${si},${v}`) as EncodedSymbol[]);
      if (!slots.includes(voice) && shown.length) symbols = measureRestsLike(shown[0], layout[voice] === 'T');
      if (!symbols) return;
      forVoice.push(...symbols, new EncodedSymbol('newline'));
    });
    voices.push(restoreUnmarkedTriplets(removeDuplicatedSymbols(forVoice)));
  }
  if (opts.dump) opts.dump.voices = voices.map((v) => v.map(String));
  return voices;
}

/** MusicXML of several pages read one by one (homr run_homr: one file per page, joined with relieur). */
export function pagesToMusicXml(pages: El[], title = ''): string {
  if (!pages.length) throw new NoMusicError('No pages');
  const root = pages.length === 1 ? pages[0] : joinPages(pages);
  const t = root.find('work/work-title');
  if (t && title) t.text = title;
  return serialize(root);
}
