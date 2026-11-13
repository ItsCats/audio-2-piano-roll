/**
 * Sheet-music reading (src/lib/omr) without the model: the **kern reader (spines, chords, rests,
 * dots, tuplets, ties, grace notes, signatures, bar snapping), the MusicXML it writes (through the
 * normal score import), the staff / system finder on generated page images, page clean-up, and the
 * support check.
 */
import { describe, expect, it } from 'vitest';
import { bekernToKern, kernDuration, kernPitch, parseKernSystems, soundingNotes } from '../../src/lib/omr/kern';
import { kernToMusicXml, noteType } from '../../src/lib/omr/musicxml';
import { frac, num } from '../../src/lib/omr/frac';
import { gray, rotate, warpQuad, type Gray, type Quad } from '../../src/lib/omr/image';
import { detectPageQuad, preparePage, skewAngle } from '../../src/lib/omr/page';
import { findStaves, groupSystems, systemImage, MODEL_MIN_HEIGHT, MODEL_STAFF_SPACE } from '../../src/lib/omr/staves';
import { assemble, sheetReaderSupport, SheetReadError } from '../../src/lib/omr';
import { importMusicXml } from '../../src/lib/score';
import { scoreNotes } from '../e2e/omrScore';

const K = (rows: string[][]) => rows.map((r) => r.join('\t')).join('\n');
const HEAD = [
  ['**kern', '**kern'],
  ['*clefF4', '*clefG2'],
  ['*k[f#]', '*k[f#]'],
  ['*M4/4', '*M4/4'],
];

describe('kern tokens', () => {
  it('reads pitches like **kern (c = middle C)', () => {
    expect(kernPitch('4c')?.midi).toBe(60);
    expect(kernPitch('4cc')?.midi).toBe(72);
    expect(kernPitch('4C')?.midi).toBe(48);
    expect(kernPitch('4CC')?.midi).toBe(36);
    expect(kernPitch('8f#L')).toMatchObject({ step: 'F', alter: 1, octave: 4, midi: 66 });
    expect(kernPitch('2B--')).toMatchObject({ step: 'B', alter: -2, octave: 3, midi: 57 });
    expect(kernPitch('4an')).toMatchObject({ step: 'A', alter: 0, midi: 69 });
    expect(kernPitch('4r')).toBeNull();
  });
  it('reads durations: dots, tuplets, breves', () => {
    expect(num(kernDuration('4c')!)).toBe(1);
    expect(num(kernDuration('8.c')!)).toBe(0.75);
    expect(num(kernDuration('2..c')!)).toBe(3.5);
    expect(kernDuration('12c')).toEqual(frac(1, 3));
    expect(kernDuration('20c')).toEqual(frac(1, 5));
    expect(num(kernDuration('0c')!)).toBe(8);
    expect(num(kernDuration('3%2c')!)).toBeCloseTo(8 / 3);
    expect(kernDuration('c')).toBeNull();
  });
  it('turns bekern tokens into **kern lines', () => {
    expect(bekernToKern(['**ekern_1.0', '<t>', '**ekern_1.0', '<b>', '4·c', '<s>', '4e', '<t>', '.'])).toBe('**ekern_1.0\t**ekern_1.0\n4c 4e\t.');
  });
});

describe('parseKernSystems', () => {
  it('reads two spines as left hand (first) and right hand, with chords and rests', () => {
    const k = K([...HEAD, ['=1', '=1'], ['2C 2G', '4c 4e'], ['.', '4r'], ['2D', '2d'], ['==', '=='], ['*-', '*-']]);
    const p = parseKernSystems([k]);
    expect(p.meter).toEqual({ beats: 4, beatType: 4 });
    expect(p.fifths).toBe(1);
    expect(p.measures).toHaveLength(1);
    const notes = soundingNotes(p);
    expect(notes.map((n) => [n.staff, n.midi, n.onset, n.dur])).toEqual([
      [2, 48, 0, 2],
      [2, 55, 0, 2],
      [1, 60, 0, 1],
      [1, 64, 0, 1],
      [2, 50, 2, 2],
      [1, 62, 2, 2],
    ]);
    expect(p.measures[0].clefs).toEqual({ 1: { sign: 'G', line: 2 }, 2: { sign: 'F', line: 4 } });
  });

  it('follows spine splits and merges', () => {
    const k = K([
      ...HEAD,
      ['=1', '=1'],
      ['*', '*^'],
      ['1C', '2e', '4g'],
      ['.', '.', '4a'],
      ['.', '2f', '2b'],
      ['*', '*v', '*v'],
      ['=2', '='],
      ['1D', '1c'],
      ['*-', '*-'],
    ]);
    const p = parseKernSystems([k]);
    expect(p.measures).toHaveLength(2);
    const rh = soundingNotes(p).filter((n) => n.staff === 1);
    expect(rh.map((n) => [n.midi, n.onset])).toEqual([
      [64, 0],
      [67, 0],
      [69, 1],
      [65, 2],
      [71, 2],
      [60, 4],
    ]);
  });

  it('keeps triplets exact and merges ties', () => {
    const k = K([...HEAD, ['=1', '=1'], ['2C', '12c'], ['.', '12d'], ['.', '12e'], ['.', '4f'], ['2C', '2g['], ['=2', '=2'], ['1C', '4g]'], ['.', '2.r'], ['*-', '*-']]);
    const p = parseKernSystems([k]);
    const rh = soundingNotes(p).filter((n) => n.staff === 1);
    expect(rh.map((n) => n.onset)).toEqual([0, 1 / 3, 2 / 3, 1, 2]);
    // g tied across the bar line: one note of 3 beats
    expect(rh[4]).toMatchObject({ midi: 67, dur: 3 });
    const m1 = p.measures[0];
    expect(m1.notes.find((n) => n.midi === 62)?.onset).toEqual(frac(1, 3));
  });

  it('keeps grace notes without duration', () => {
    const k = K([...HEAD, ['=1', '=1'], ['1C', '8qd'], ['.', '1c'], ['*-', '*-']]);
    const p = parseKernSystems([k]);
    const g = p.measures[0].notes.find((n) => n.grace);
    expect(g).toMatchObject({ midi: 62, grace: true });
    expect(num(g!.dur)).toBe(0);
    expect(soundingNotes(p).map((n) => n.midi)).toEqual([48, 60]);
  });

  it('snaps bars to the time signature: short bars are filled, both hands start each bar together', () => {
    // bar 1: the right hand has only 3 beats; bar 2 must still start at beat 4
    const k = K([...HEAD, ['=1', '=1'], ['1C', '2c'], ['.', '4d'], ['=2', '=2'], ['1D', '1e'], ['*-', '*-']]);
    const p = parseKernSystems([k]);
    expect(p.measures.map((m) => num(m.start))).toEqual([0, 4]);
    expect(soundingNotes(p).find((n) => n.midi === 64)?.onset).toBe(4);
  });

  it('lengthens an over-full bar by default (no note lost) and can squeeze or cut it', () => {
    const k = K([...HEAD, ['=1', '=1'], ['1C', '2c'], ['.', '2d'], ['.', '4e'], ['=2', '=2'], ['1D', '1f'], ['*-', '*-']]);
    const ext = parseKernSystems([k]);
    expect(ext.overfullBars).toBe(1);
    expect(num(ext.measures[0].length)).toBe(5);
    expect(soundingNotes(ext).map((n) => n.midi)).toContain(64);
    const sq = parseKernSystems([k], { overfull: 'squeeze' });
    expect(num(sq.measures[1].start)).toBe(4);
    expect(soundingNotes(sq).find((n) => n.midi === 64)?.onset).toBeCloseTo(3.2);
    const clip = parseKernSystems([k], { overfull: 'clip' });
    expect(soundingNotes(clip).map((n) => n.midi)).not.toContain(64);
  });

  it('treats a short first bar as a pickup', () => {
    const k = K([...HEAD, ['=1', '=1'], ['4C', '4g'], ['=2', '=2'], ['1C', '1c'], ['*-', '*-']]);
    const p = parseKernSystems([k]);
    expect(p.measures[0].pickup).toBe(true);
    expect(num(p.measures[1].start)).toBe(1);
  });

  it('carries the time signature over systems unless the new one fits the bars better', () => {
    const sys1 = K([['**kern', '**kern'], ['*clefF4', '*clefG2'], ['*M3/4', '*M3/4'], ['=1', '=1'], ['2.C', '2.c'], ['*-', '*-']]);
    // the second system has 3/4 bars but the model guessed 4/4: ignored
    const sys2 = K([['**kern', '**kern'], ['*clefF4', '*clefG2'], ['*M4/4', '*M4/4'], ['=2', '=2'], ['2.C', '2.d'], ['=3', '=3'], ['2.C', '2.e'], ['*-', '*-']]);
    const p = parseKernSystems([sys1, sys2]);
    expect(p.measures.map((m) => num(m.start))).toEqual([0, 3, 6]);
    expect(p.measures.slice(1).some((m) => m.meter)).toBe(false);
    expect(p.measures[1].systemStart).toBe(true);
    // a real change (the bars agree with it) is taken
    const sys3 = K([['**kern', '**kern'], ['*M2/4', '*M2/4'], ['=4', '=4'], ['2C', '2c'], ['=5', '=5'], ['2C', '2c'], ['*-', '*-']]);
    const q = parseKernSystems([sys1, sys3]);
    expect(q.measures[1].meter).toEqual({ beats: 2, beatType: 4 });
  });

  it('uses the most common key signature of the systems', () => {
    const sys = (k: string) => K([['**kern', '**kern'], [`*k[${k}]`, `*k[${k}]`], ['*M2/4', '*M2/4'], ['=', '='], ['2C', '2c'], ['*-', '*-']]);
    const p = parseKernSystems([sys('b-'), sys('b-e-'), sys('b-')]);
    expect(p.fifths).toBe(-1);
    expect(p.measures.filter((m) => m.fifths !== undefined).length).toBe(1);
  });

  it('survives malformed lines (missing fields, junk, no header)', () => {
    const k = ['4C\t4c', '4D', 'foo\t4e', '=\t=', '*-\t*-'].join('\n');
    const p = parseKernSystems([k]);
    expect(soundingNotes(p).map((n) => n.midi)).toEqual([48, 60, 50, 64]);
    expect(parseKernSystems(['']).measures).toEqual([]);
  });
});

describe('MusicXML output', () => {
  it('writes note types, dots and tuplets', () => {
    expect(noteType(1)).toEqual({ type: 'quarter', dots: 0 });
    expect(noteType(1.5)).toEqual({ type: 'quarter', dots: 1 });
    expect(noteType(1 / 3)).toEqual({ type: 'eighth', dots: 0, tuplet: [3, 2] });
    expect(noteType(0.2)).toEqual({ type: '16th', dots: 0, tuplet: [5, 4] });
    expect(noteType(0.37)).toBeNull();
  });

  it('round-trips through the score import: notes, hands, ties, triplets, key and time', () => {
    const k = K([
      ...HEAD,
      ['=1', '=1'],
      ['2C 2G', '12c'],
      ['.', '12d'],
      ['.', '12e'],
      ['.', '4f#'],
      ['2D', '2g['],
      ['=2', '=2'],
      ['1C', '4g]'],
      ['.', '8qa'],
      ['.', '4.b'],
      ['.', '8cc'],
      ['.', '4r'],
      ['==', '=='],
      ['*-', '*-'],
    ]);
    const piece = parseKernSystems([k]);
    const xml = kernToMusicXml(piece, { title: 'Test & <piece>' });
    expect(xml).toContain('<work-title>Test &amp; &lt;piece&gt;</work-title>');
    expect(xml).toContain('<time-modification><actual-notes>3</actual-notes>');
    const parsed = importMusicXml(xml);
    expect(parsed.key).toMatchObject({ fifths: 1 });
    expect(parsed.tempo.beatsPerBar).toBe(4);
    expect(parsed.measures.written).toBe(2);
    const spq = 60 / parsed.tempo.bpm;
    const got = parsed.notes.map((n) => [n.midi, +(n.start / spq).toFixed(3), +(n.dur / spq).toFixed(3), n.hand]);
    const want = soundingNotes(piece).map((n) => [n.midi, +n.onset.toFixed(3), +n.dur.toFixed(3), n.staff === 1 ? 'R' : 'L']);
    expect(got.map((g) => g.slice(0, 2))).toEqual(expect.arrayContaining(want.map((w) => w.slice(0, 2))));
    expect(got.find((g) => g[0] === 67)?.[2]).toBe(3);
    expect(parsed.handsKnown).toBe(true);
    // hands from the staves
    expect(parsed.notes.filter((n) => n.midi < 60).every((n) => n.hand === 'L')).toBe(true);
  });

  it('writes a pickup as an implicit measure 0', () => {
    const k = K([...HEAD, ['=1', '=1'], ['4C', '4g'], ['=2', '=2'], ['1C', '1c'], ['*-', '*-']]);
    const xml = kernToMusicXml(parseKernSystems([k]));
    expect(xml).toContain('<measure number="0" implicit="yes">');
    const parsed = importMusicXml(xml);
    expect(parsed.notes.length).toBe(4);
  });
});

// ------------------------------------------------------------------ generated pages

/** A page with `systems` grand staves (two 5-line staves joined by a line on the left) and some notes. */
function page(opts: { systems: number; space?: number; w?: number; h?: number; noise?: number }): { img: Gray; staffTops: number[] } {
  const w = opts.w ?? 1654;
  const h = opts.h ?? 2339;
  const sp = opts.space ?? 16;
  const img = gray(w, h);
  const set = (x: number, y: number, v = 0) => {
    if (x >= 0 && y >= 0 && x < w && y < h) img.d[Math.round(y) * w + Math.round(x)] = v;
  };
  const tops: number[] = [];
  let y = 260;
  const x0 = 150;
  const x1 = w - 120;
  for (let s = 0; s < opts.systems; s++) {
    for (let st = 0; st < 2; st++) {
      const top = y + st * 9 * sp;
      tops.push(top);
      for (let l = 0; l < 5; l++) for (let x = x0; x < x1; x++) (set(x, top + l * sp), set(x, top + l * sp + 1));
      // note heads (filled ellipses) and stems
      for (let k = 0; k < 16; k++) {
        const cx = x0 + 120 + k * ((x1 - x0 - 160) / 16);
        const cy = top + ((k * 7) % 9) * (sp / 2);
        for (let dy = -sp / 2; dy <= sp / 2; dy++) for (let dx = -sp * 0.65; dx <= sp * 0.65; dx++) if ((dx / (sp * 0.65)) ** 2 + (dy / (sp / 2)) ** 2 <= 1) set(cx + dx, cy + dy);
        for (let dy = 0; dy < 3.5 * sp; dy++) (set(cx + sp * 0.6, cy - dy), set(cx + sp * 0.6 + 1, cy - dy));
      }
    }
    // system line on the left and bar lines across both staves
    const yTop = y;
    const yBot = y + 9 * sp + 4 * sp;
    for (const bx of [x0, x0 + (x1 - x0) / 2, x1 - 2]) for (let yy = yTop; yy <= yBot; yy++) (set(bx, yy), set(bx + 1, yy));
    y += 9 * sp + 4 * sp + 10 * sp;
  }
  // title text block (dark blob, not lines)
  for (let yy = 120; yy < 170; yy++) for (let x = w / 2 - 200; x < w / 2 + 200; x += 3) set(x, yy);
  if (opts.noise) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < img.d.length; i++) img.d[i] = Math.max(0, Math.min(255, img.d[i] + (rnd() - 0.5) * opts.noise));
  }
  return { img, staffTops: tops };
}

describe('staff and system finding', () => {
  it('finds every staff and pairs them into grand staves', () => {
    const { img, staffTops } = page({ systems: 4 });
    const f = findStaves(img);
    expect(f.staves.length).toBe(8);
    f.staves.forEach((s, i) => {
      expect(Math.abs(s.lines[0] - staffTops[i])).toBeLessThan(3);
      expect(s.space).toBeCloseTo(16, 0);
    });
    const sys = groupSystems(img, f);
    expect(sys.map((s) => s.staves)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    expect(sys[0].barlines).toBeGreaterThanOrEqual(2);
    // the model input: staff space scaled to what it was trained on, at least 256 px tall
    const im = systemImage(img, sys[0]);
    expect(im.h).toBeGreaterThanOrEqual(MODEL_MIN_HEIGHT);
    expect(im.w).toBeCloseTo(((sys[0].x1 - sys[0].x0) * MODEL_STAFF_SPACE) / sys[0].space, -1);
  });

  it('works on a noisy, slightly tilted and shadowed page', () => {
    const { img } = page({ systems: 3, space: 14, noise: 40 });
    const tilted = rotate(img, 1.5);
    // a shadow over the right half
    for (let y = 0; y < tilted.h; y++) for (let x = tilted.w / 2; x < tilted.w; x++) tilted.d[y * tilted.w + x] = Math.round(tilted.d[y * tilted.w + x] * 0.55);
    expect(Math.abs(skewAngle(tilted) + 1.5)).toBeLessThan(0.3);
    const { page: pg } = preparePage(tilted);
    const f = findStaves(pg);
    expect(f.staves.length).toBe(6);
    expect(groupSystems(pg, f).length).toBe(3);
  });

  it('finds the page in a photo and straightens it', () => {
    const { img } = page({ systems: 2, w: 827, h: 1170, space: 9 });
    // the page on a dark table, tilted in perspective
    const W = 1200;
    const H = 1500;
    const photo = gray(W, H, 60);
    const quad: Quad = [
      [180, 150],
      [1010, 190],
      [1050, 1330],
      [140, 1290],
    ];
    // paste the page through the inverse warp: sample the page for each photo pixel inside the quad
    const back = warpQuad(photo, quad, 827); // only to get the output size right
    expect(back.w).toBe(827);
    // forward map: draw page pixels at their perspective position (bilinear blend of corners)
    for (let v = 0; v < img.h; v++) {
      for (let u = 0; u < img.w; u++) {
        const a = u / img.w;
        const b = v / img.h;
        const x = (1 - a) * (1 - b) * quad[0][0] + a * (1 - b) * quad[1][0] + a * b * quad[2][0] + (1 - a) * b * quad[3][0];
        const y = (1 - a) * (1 - b) * quad[0][1] + a * (1 - b) * quad[1][1] + a * b * quad[2][1] + (1 - a) * b * quad[3][1];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const X = Math.floor(x) + dx;
          const Y = Math.floor(y) + dy;
          if (X < W && Y < H) photo.d[Y * W + X] = Math.min(photo.d[Y * W + X] === 60 ? 255 : photo.d[Y * W + X], img.d[v * img.w + u]);
        }
      }
    }
    const q = detectPageQuad(photo);
    expect(q).not.toBeNull();
    q!.forEach((p, i) => {
      expect(Math.abs(p[0] - quad[i][0])).toBeLessThan(25);
      expect(Math.abs(p[1] - quad[i][1])).toBeLessThan(25);
    });
    const { page: pg } = preparePage(photo, { quad: q });
    const f = findStaves(pg);
    expect(f.staves.length).toBe(4);
    expect(groupSystems(pg, f).length).toBe(2);
  });

  it('finds a page corner lost in shadow where the two sides meet', () => {
    const W = 1000;
    const H = 1300;
    const photo = gray(W, H, 60);
    const quad: Quad = [
      [120, 100],
      [880, 140],
      [900, 1200],
      [100, 1180],
    ];
    // paper inside the quad (point-in-convex-polygon), with the bottom-right corner in deep shadow
    const inside = (x: number, y: number) =>
      quad.every((a, i) => {
        const b = quad[(i + 1) % 4];
        return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0;
      });
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (inside(x, y)) photo.d[y * W + x] = x + y > 1880 ? 70 : 235;
    const q = detectPageQuad(photo);
    expect(q).not.toBeNull();
    q!.forEach((p, i) => {
      expect(Math.abs(p[0] - quad[i][0])).toBeLessThan(15);
      expect(Math.abs(p[1] - quad[i][1])).toBeLessThan(15);
    });
  });

  it('finds nothing on an empty page', () => {
    const f = findStaves(gray(800, 1100));
    expect(f.staves).toEqual([]);
    expect(groupSystems(gray(800, 1100), f)).toEqual([]);
  });
});

describe('assemble + support', () => {
  const stats = { fromCache: true, reusedSession: true, loadMs: 0, createMs: 0, prepareMs: 0, encodeMs: 0, decodeMs: 0, steps: 0, threads: 1 };
  const pageInfo = { staves: 2, systems: 1, w: 1654, h: 2339, quad: null };
  it('builds MusicXML from the systems and says what went wrong in plain words', () => {
    const k = K([...HEAD, ['=1', '=1'], ['1C', '1c'], ['=2', '=2'], ['1D', '1d'], ['*-', '*-']]);
    const r = assemble({ systems: [{ page: 0, kern: k, steps: 20, finished: false, box: { x0: 0, y0: 0, x1: 1, y1: 1 }, barlines: 3, ms: 1 }], pages: [pageInfo, { ...pageInfo, staves: 0, systems: 0 }], stats }, 2, { kind: 'pdf', title: 'T' });
    expect(r.lines).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/page 2/);
    expect(r.warnings.join(' ')).toMatch(/could not be read to the end/);
    const parsed = importMusicXml(r.musicXml);
    expect(scoreNotes([{ midi: 48, onset: 0 }, { midi: 60, onset: 0 }, { midi: 50, onset: 4 }, { midi: 62, onset: 4 }], parsed.notes.map((n) => ({ midi: n.midi, onset: n.start * (parsed.tempo.bpm / 60) }))).notesF1).toBe(1);
  });
  it('rejects pages with no music', () => {
    expect(() => assemble({ systems: [], pages: [{ ...pageInfo, staves: 0, systems: 0 }], stats }, 1, { kind: 'photo' })).toThrow(SheetReadError);
  });
  it('recommends the reader on desktops and warns on phones', () => {
    const desk = sheetReaderSupport('pdf', { ua: 'Mozilla/5.0 (X11; Linux x86_64)', deviceMemory: 8 }, 3, { worker: true, simd: true });
    expect(desk).toMatchObject({ available: true, recommended: true });
    expect(desk.downloadMB).toBeGreaterThan(5);
    const phone = sheetReaderSupport('photo', { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 }, 1, { worker: true, simd: true });
    expect(phone).toMatchObject({ available: true, recommended: false, phone: true });
    expect(phone.reason).toMatch(/phone/);
    expect(sheetReaderSupport('pdf', undefined, 1, { worker: true, simd: false }).available).toBe(false);
  });
});
