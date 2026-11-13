// Dev-only page for tests/e2e/homr.mjs: the homr sheet-music reader (src/lib/omr/homr) end to end. A
// small piano piece is made up in code (so its notes are known exactly), engraved with the app's
// notation library (OSMD), drawn as a 1654 x 2339 page (A4 at 200 dpi) and read back; the MusicXML goes
// through the normal score import and is scored note by note (tests/e2e/homrScore.ts).
import { loadOsmd } from '../../src/lib/sheet/render';
import { homrEngine, homrReaderSupport, readSheetImages } from '../../src/lib/omr/homr';
import { importMusicXml } from '../../src/lib/score';
import { scoreNotes, type ScoreNote } from './homrScore';

declare global {
  interface Window {
    support: () => unknown;
    makePiece: (seed: number) => Promise<{ notes: number; png: string }>;
    readPage: (threads?: number) => Promise<unknown>;
    readAbort: () => Promise<unknown>;
  }
}

const log = (s: string) => (document.getElementById('log')!.textContent = s);

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
const TYPE: Record<number, string> = { 4: 'whole', 2: 'half', 1.5: 'quarter', 1: 'quarter', 0.5: 'eighth' };

/** C major, 4/4: a right-hand tune (some thirds) over a left-hand bass, `bars` bars. */
function makePiece(seed: number, bars = 12): { notes: PNote[]; xml: string } {
  const r = rng(seed);
  const RH = [[1, 1, 1, 1], [2, 1, 1], [1, 1, 2], [0.5, 0.5, 1, 1, 1], [1.5, 0.5, 2], [2, 2]];
  const LH = [[2, 2], [1, 1, 1, 1], [4]];
  const notes: PNote[] = [];
  let rd = 4 * 7 + 4; // G4
  for (let b = 0; b < bars; b++) {
    let t = 0;
    for (const d of b === bars - 1 ? [4] : RH[Math.floor(r() * RH.length)]) {
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
          `<note>${chord ? '<chord/>' : ''}<pitch><step>${STEPS[n.d % 7]}</step><octave>${Math.floor(n.d / 7)}</octave></pitch><duration>${n.dur * 2}</duration><voice>${staff}</voice><type>${TYPE[n.dur]}</type>${n.dur === 1.5 ? '<dot/>' : ''}<staff>${staff}</staff></note>`,
        );
      }
      if (staff === 1) body.push('<backup><duration>8</duration></backup>');
    }
    m.push(`<measure number="${b + 1}">${body.join('')}</measure>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>Study ${seed}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${m.join('')}</part></score-partwise>`;
  return { notes, xml };
}

async function svgToCanvas(svg: SVGSVGElement, width: number, height: number): Promise<HTMLCanvasElement> {
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
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, Math.round(w0 * s), Math.round(h0 * s));
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let truth: ScoreNote[] = [];
let page: HTMLCanvasElement | null = null;

window.support = () => homrReaderSupport();

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
  page = await svgToCanvas(host.querySelector('svg') as SVGSVGElement, 1654, 2339);
  host.remove();
  return { notes: truth.length, png: page.toDataURL('image/png') };
};

function score(xml: string) {
  const parsed = importMusicXml(xml);
  const qps = parsed.tempo.bpm / 60 / ((parsed.tempo.beatUnit ?? 4) / 4);
  return scoreNotes(
    truth,
    parsed.notes.map((n) => ({ midi: n.midi, onset: n.start * qps })),
  );
}

window.readPage = async (threads) => {
  if (!page) throw new Error('no page');
  let progressMax = 0;
  let last = 0;
  let monotonic = true;
  const stages = new Set<string>();
  const t0 = performance.now();
  const bitmap = await createImageBitmap(page);
  const res = await homrEngine.readPages([bitmap], {
    threads,
    title: 'Study',
    onProgress: (p) => {
      if (p.progress + 1e-9 < last) monotonic = false;
      last = p.progress;
      progressMax = Math.max(progressMax, p.progress);
      stages.add(p.stage);
    },
  });
  bitmap.close();
  return {
    ...score(res.musicXml),
    staves: res.staves,
    lines: res.lines,
    warnings: res.warnings,
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    stats: res.stats,
    progressMax: +progressMax.toFixed(3),
    monotonic,
    stages: [...stages],
    titled: res.musicXml.includes('<work-title>Study</work-title>'),
  };
};

window.readAbort = async () => {
  const ac = new AbortController();
  let abortedAt = 0;
  const t0 = performance.now();
  try {
    await readSheetImages([{ image: page! }], {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.stage === 'finding-lines' && !abortedAt) {
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
