// Dev-only page for tests/e2e/omr.mjs: the sheet-music reader end to end. A small piano piece is made
// up in code (so its notes are known exactly), engraved with the app's notation library (OSMD), turned
// into a PNG page, a PDF (jsPDF) and a phone-like photo, and read back with src/lib/omr; the MusicXML
// goes through the normal score import and is scored note by note (tests/e2e/omrScore.ts).
import { loadOsmd } from '../../src/lib/sheet/render';
import { readSheetImages, renderPdfPages, sheetReaderSupport, loadPhoto, grayFromImageData, type Gray, type Quad } from '../../src/lib/omr';
import { importMusicXml } from '../../src/lib/score';
import { scoreNotes, type ScoreNote } from './omrScore';

declare global {
  interface Window {
    support: () => unknown;
    makePiece: (seed: number) => Promise<{ notes: number; measures: number; png: string }>;
    readAs: (how: 'png' | 'pdf' | 'photo') => Promise<unknown>;
    readAbort: () => Promise<unknown>;
  }
}

const log = (s: string) => (document.getElementById('log')!.textContent = s);

// ------------------------------------------------------------------ a made-up piece

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMI = [0, 2, 4, 5, 7, 9, 11];
interface PNote {
  /** diatonic index: octave * 7 + step */
  d: number;
  onset: number;
  dur: number;
  staff: 1 | 2;
}
const midiOf = (d: number) => 12 * (Math.floor(d / 7) + 1) + SEMI[d % 7];
const TYPE: Record<number, string> = { 4: 'whole', 3: 'half', 2: 'half', 1.5: 'quarter', 1: 'quarter', 0.5: 'eighth' };

/** C major, 4/4, `bars` bars: a right-hand tune and a left-hand bass in quarters / halves. */
function makePiece(seed: number, bars = 8): { notes: PNote[]; xml: string } {
  const r = rng(seed);
  const RH = [[1, 1, 1, 1], [2, 1, 1], [1, 1, 2], [0.5, 0.5, 1, 1, 1], [1.5, 0.5, 2], [2, 2]];
  const LH = [[2, 2], [1, 1, 1, 1], [4]];
  const notes: PNote[] = [];
  let rd = 4 * 7 + 4; // G4
  for (let b = 0; b < bars; b++) {
    let t = 0;
    const rr = b === bars - 1 ? [4] : RH[Math.floor(r() * RH.length)];
    for (const d of rr) {
      rd = Math.max(4 * 7, Math.min(5 * 7 + 4, rd + Math.round((r() - 0.5) * 5)));
      notes.push({ d: rd, onset: b * 4 + t, dur: d, staff: 1 });
      if (r() < 0.25 && d >= 1) notes.push({ d: rd - 2, onset: b * 4 + t, dur: d, staff: 1 });
      t += d;
    }
    t = 0;
    const root = 3 * 7 + [0, 3, 4, 5][Math.floor(r() * 4)] - 7;
    for (const d of b === bars - 1 ? [4] : LH[Math.floor(r() * LH.length)]) {
      notes.push({ d: root + (t === 0 ? 0 : [2, 4, 7][Math.floor(r() * 3)]), onset: b * 4 + t, dur: d, staff: 2 });
      t += d;
    }
  }
  // MusicXML: divisions 2 (eighths), staff 1 then backup and staff 2
  const m: string[] = [];
  for (let b = 0; b < bars; b++) {
    const body: string[] = [];
    if (b === 0)
      body.push('<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>');
    for (const staff of [1, 2] as const) {
      const ns = notes.filter((n) => n.staff === staff && n.onset >= b * 4 && n.onset < b * 4 + 4).sort((a, c) => a.onset - c.onset || c.d - a.d);
      let prev = -1;
      for (const n of ns) {
        const chord = n.onset === prev;
        prev = n.onset;
        body.push(
          `<note>${chord ? '<chord/>' : ''}<pitch><step>${STEPS[n.d % 7]}</step><octave>${Math.floor(n.d / 7)}</octave></pitch><duration>${n.dur * 2}</duration><voice>${staff}</voice><type>${TYPE[n.dur]}</type>${n.dur === 1.5 || n.dur === 3 ? '<dot/>' : ''}<staff>${staff}</staff></note>`,
        );
      }
      if (staff === 1) body.push('<backup><duration>8</duration></backup>');
    }
    m.push(`<measure number="${b + 1}">${body.join('')}</measure>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>Study ${seed}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${m.join('')}</part></score-partwise>`;
  return { notes, xml };
}

// ------------------------------------------------------------------ engraving → images

async function svgToCanvas(svg: SVGSVGElement, width: number): Promise<HTMLCanvasElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const w0 = svg.width.baseVal.value || svg.getBoundingClientRect().width;
  const h0 = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w0));
  clone.setAttribute('height', String(h0));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = width / w0;
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * s);
    c.height = Math.round(h0 * s);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const grayOf = (c: HTMLCanvasElement): Gray => grayFromImageData(c.getContext('2d')!.getImageData(0, 0, c.width, c.height));

/** The page as a phone photo: on a dark table, in perspective, with a shadow and noise. */
function photoOf(page: HTMLCanvasElement): { canvas: HTMLCanvasElement; quad: Quad } {
  const W = 1500;
  const H = Math.round((W * page.height) / page.width) + 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#4a4036';
  ctx.fillRect(0, 0, W, H);
  // a gentle perspective: slices drawn narrower towards the top
  const top = 0.88;
  const x0 = 90;
  const pw = W - 180;
  const ph = H - 180;
  const y0 = 90;
  const slices = 200;
  for (let i = 0; i < slices; i++) {
    const a = i / slices;
    const sw = pw * (top + (1 - top) * a);
    const sx = x0 + (pw - sw) / 2;
    ctx.drawImage(page, 0, (a * page.height) | 0, page.width, Math.ceil(page.height / slices) + 1, sx, y0 + a * ph, sw, ph / slices + 1);
  }
  // uneven light
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H);
  const r = rng(99);
  for (let i = 0; i < id.data.length; i += 4) {
    const n = (r() - 0.5) * 24;
    id.data[i] += n;
    id.data[i + 1] += n;
    id.data[i + 2] += n;
  }
  ctx.putImageData(id, 0, 0);
  const sw0 = pw * top;
  const quad: Quad = [
    [x0 + (pw - sw0) / 2, y0],
    [x0 + (pw + sw0) / 2, y0],
    [x0 + pw, y0 + ph],
    [x0, y0 + ph],
  ];
  return { canvas: c, quad };
}

let truth: ScoreNote[] = [];
let pageCanvas: HTMLCanvasElement | null = null;

window.support = () => sheetReaderSupport('pdf');

window.makePiece = async (seed) => {
  const { notes, xml } = makePiece(seed);
  truth = notes.map((n) => ({ midi: midiOf(n.d), onset: n.onset }));
  const { OpenSheetMusicDisplay } = await loadOsmd();
  const host = document.createElement('div');
  host.style.width = '794px';
  document.body.appendChild(host);
  const osmd = new OpenSheetMusicDisplay(host, { autoResize: false, backend: 'svg', pageFormat: 'A4_P', pageBackgroundColor: '#FFFFFF', drawTitle: true, drawComposer: false, drawPartNames: false });
  await osmd.load(xml);
  osmd.render();
  const svg = host.querySelector('svg') as SVGSVGElement;
  pageCanvas = await svgToCanvas(svg, 1654);
  host.remove();
  return { notes: truth.length, measures: 8, png: pageCanvas.toDataURL('image/png') };
};

function scoreXml(xml: string) {
  const parsed = importMusicXml(xml);
  const qps = parsed.tempo.bpm / 60 / ((parsed.tempo.beatUnit ?? 4) / 4);
  return scoreNotes(
    truth,
    parsed.notes.map((n) => ({ midi: n.midi, onset: n.start * qps })),
  );
}

window.readAs = async (how) => {
  if (!pageCanvas) throw new Error('no page');
  let progressMax = 0;
  const stages = new Set<string>();
  const onProgress = (p: { progress: number; stage: string }) => {
    progressMax = Math.max(progressMax, p.progress);
    stages.add(p.stage);
  };
  const t0 = performance.now();
  let res;
  if (how === 'png') {
    res = await readSheetImages([{ image: grayOf(pageCanvas) }], { kind: 'pdf', onProgress, title: 'Study' });
  } else if (how === 'pdf') {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 0, 0, 595.28, (595.28 * pageCanvas.height) / pageCanvas.width);
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    const pages = await renderPdfPages(bytes);
    res = await readSheetImages(pages.map((image) => ({ image })), { kind: 'pdf', onProgress });
  } else {
    const { canvas, quad } = photoOf(pageCanvas);
    const blob = await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b!), 'image/jpeg', 0.8));
    (window as unknown as { lastPhoto: string }).lastPhoto = canvas.toDataURL('image/jpeg', 0.8);
    const photo = await loadPhoto(blob);
    const s = photo.image.w / canvas.width;
    // the corner screen's starting point, compared with the true corners
    const found = photo.quad;
    const cornerErr = found ? Math.max(...found.map((p, i) => Math.hypot(p[0] / s - quad[i][0], p[1] / s - quad[i][1]))) : null;
    res = await readSheetImages([{ image: photo.image, quad: quad.map(([x, y]) => [x * s, y * s]) as Quad }], { kind: 'photo', onProgress });
    return { ...summary(res, t0, progressMax, stages), cornerErr: cornerErr && Math.round(cornerErr) };
  }
  return summary(res, t0, progressMax, stages);
};

function summary(res: Awaited<ReturnType<typeof readSheetImages>>, t0: number, progressMax: number, stages: Set<string>) {
  return {
    ...scoreXml(res.musicXml),
    lines: res.lines,
    warnings: res.warnings,
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    steps: res.stats.steps,
    threads: res.stats.threads,
    fromCache: res.stats.fromCache,
    progressMax: +progressMax.toFixed(3),
    stages: [...stages],
  };
}

window.readAbort = async () => {
  const ac = new AbortController();
  let abortedAt = 0;
  const t0 = performance.now();
  try {
    await readSheetImages([{ image: grayOf(pageCanvas!) }], {
      kind: 'pdf',
      signal: ac.signal,
      onProgress: (p) => {
        if (p.stage === 'reading' && !abortedAt) {
          abortedAt = performance.now();
          ac.abort();
        }
      },
    });
    return { rejected: false };
  } catch (e) {
    return { rejected: true, name: (e as Error).name, rejectAfterAbortMs: Math.round(performance.now() - (abortedAt || t0)) };
  }
};

log('ready');
