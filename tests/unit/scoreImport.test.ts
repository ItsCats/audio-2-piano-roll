/**
 * Sheet-music import (src/lib/score): XML reader, MusicXML semantics (divisions, backup/forward,
 * chords, voices, staves, ties, tuplets, grace notes, tempo, transposition, octave marks,
 * dynamics, pedal, fermatas), repeat unrolling, .mxl containers, and a round trip through our own
 * MusicXML writer (src/lib/sheet).
 */
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseXml, decodeXmlBytes } from '../../src/lib/score/xml';
import { importMusicXml, readScoreFile, scoreTiming, ScoreImportError, keyFromSignature, musicXmlToIR, isScoreFileName } from '../../src/lib/score';
import { unroll } from '../../src/lib/score/unroll';
import { jumpFromWords, parseEndingNumbers, tempoFromWords, type IRMeasure } from '../../src/lib/score/ir';
import { buildScore, toMusicXml } from '../../src/lib/sheet';
import { DIV, type Score } from '../../src/lib/sheet/types';
import { bachPreludeDemo } from '../../src/lib/music/demo';
import { regularBeats } from '../../src/lib/music/beats';
import type { Note, TempoInfo } from '../../src/lib/music/types';
import { songFromScore } from '../../src/lib/songs';

// ---------------------------------------------------------------- helpers

const PART_LIST = (parts: string[]) =>
  `<part-list>${parts.map((name, i) => `<score-part id="P${i + 1}"><part-name>${name}</part-name></score-part>`).join('')}</part-list>`;

/** A partwise score from measure bodies per part. */
function score(parts: { name?: string; measures: string[] }[], head = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">${head}${PART_LIST(parts.map((p) => p.name ?? 'Piano'))}${parts
    .map((p, i) => `<part id="P${i + 1}">${p.measures.map((m, k) => `<measure number="${k + 1}">${m}</measure>`).join('')}</part>`)
    .join('')}</score-partwise>`;
}
const ATTR = (o: { div?: number; beats?: number; type?: number; fifths?: number; staves?: number; extra?: string } = {}) =>
  `<attributes><divisions>${o.div ?? 1}</divisions><key><fifths>${o.fifths ?? 0}</fifths></key><time><beats>${o.beats ?? 4}</beats><beat-type>${o.type ?? 4}</beat-type></time>${
    o.staves ? `<staves>${o.staves}</staves>` : ''
  }${o.extra ?? ''}</attributes>`;
const STEP = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALT = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
/** A <note> of a MIDI pitch (or a rest when midi is null). */
function N(midi: number | null, dur: number, more = '', inner = ''): string {
  const pitch =
    midi === null
      ? '<rest/>'
      : `<pitch><step>${STEP[midi % 12]}</step>${ALT[midi % 12] ? `<alter>${ALT[midi % 12]}</alter>` : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
  return `<note>${inner}${pitch}<duration>${dur}</duration>${more}</note>`;
}
const TEMPO = (qpm: number) => `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${qpm}</per-minute></metronome></direction-type><sound tempo="${qpm}"/></direction>`;

/** Notes as compact tuples [midi, start, dur] rounded to ms. */
const tuples = (notes: Note[]) => notes.map((n) => [n.midi, +n.start.toFixed(3), +n.dur.toFixed(3)]);

/** Order of performed measure numbers. */
function playOrder(xml: string): string[] {
  const ir = musicXmlToIR(xml);
  return unroll(ir.measures).order.map((p) => ir.measures[p.index].label);
}
/** One note per measure (pitch 60 + measure index) so the played order can be read off the notes. */
function structure(barlines: Record<number, string>, n: number, extra: Record<number, string> = {}): string {
  const ms: string[] = [];
  for (let i = 1; i <= n; i++) ms.push(`${i === 1 ? ATTR() + TEMPO(60) : ''}${extra[i] ?? ''}${N(59 + i, 4)}${barlines[i] ?? ''}`);
  return score([{ measures: ms }]);
}
const fwd = '<barline location="left"><repeat direction="forward"/></barline>';
const back = (times?: number) => `<barline location="right"><repeat direction="backward"${times ? ` times="${times}"` : ''}/></barline>`;
const endStart = (num: string) => `<barline location="left"><ending number="${num}" type="start"/></barline>`;
const endStop = (num: string, type = 'stop') => `<barline location="right"><ending number="${num}" type="${type}"/></barline>`;
const words = (w: string, sound = '') => `<direction><direction-type><words>${w}</words></direction-type>${sound}</direction>`;

// ---------------------------------------------------------------- XML reader

describe('xml reader', () => {
  it('parses elements, attributes, entities, CDATA and skips DOCTYPE / comments / PIs', () => {
    const r = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- c --><a x='1' y="&lt;2&gt;"><b>T &amp; &#65;&#x42;</b><![CDATA[<raw>]]><c/></a>`);
    expect(r.name).toBe('a');
    expect(r.attrs).toEqual({ x: '1', y: '<2>' });
    expect(r.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(r.children[0].text).toBe('T & AB');
    expect(r.text).toBe('<raw>');
  });
  it('rejects malformed XML', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a>')).toThrow();
  });
  it('decodes UTF-16 and declared encodings', () => {
    const s = '<?xml version="1.0" encoding="UTF-16"?><a>é</a>';
    const u16 = new Uint8Array(2 + s.length * 2);
    u16[0] = 0xff;
    u16[1] = 0xfe;
    for (let i = 0; i < s.length; i++) u16[2 + i * 2] = s.charCodeAt(i);
    expect(decodeXmlBytes(u16)).toBe(s);
    const latin = new Uint8Array([...strToU8('<?xml version="1.0" encoding="ISO-8859-1"?><a>'), 0xe9, ...strToU8('</a>')]);
    expect(parseXml(decodeXmlBytes(latin)).text).toBe('é');
  });
});

// ---------------------------------------------------------------- basic semantics

describe('MusicXML semantics', () => {
  it('divisions, chords, rests, backup/forward, voices and staves → hands', () => {
    const m1 =
      ATTR({ div: 4, staves: 2 }) +
      TEMPO(60) +
      // RH voice 1: C5 quarter, rest quarter, E5+G5 chord half
      N(72, 4, '<voice>1</voice><staff>1</staff>') +
      N(null, 4, '<voice>1</voice><staff>1</staff>') +
      N(76, 8, '<voice>1</voice><staff>1</staff>') +
      N(79, 8, '<voice>1</voice><staff>1</staff>', '<chord/>') +
      '<backup><duration>16</duration></backup>' +
      // RH voice 2: forward a half, then G4 half
      '<forward><duration>8</duration><voice>2</voice><staff>1</staff></forward>' +
      N(67, 8, '<voice>2</voice><staff>1</staff>') +
      '<backup><duration>16</duration></backup>' +
      // LH: C3 whole
      N(48, 16, '<voice>5</voice><staff>2</staff>');
    const p = importMusicXml(score([{ measures: [m1] }]));
    expect(tuples(p.notes)).toEqual([
      [48, 0, 4],
      [72, 0, 1],
      [67, 2, 2],
      [76, 2, 2],
      [79, 2, 2],
    ]);
    expect(p.notes.find((n) => n.midi === 48)!.hand).toBe('L');
    expect(p.notes.filter((n) => n.midi !== 48).every((n) => n.hand === 'R')).toBe(true);
    expect(p.handsKnown).toBe(true);
    expect(p.tempo).toMatchObject({ bpm: 60, beatsPerBar: 4, beatUnit: 4, downbeatIndex: 0, source: 'midi' });
    expect(p.tempo.beats.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('ties are merged across barlines and voices of the same staff; tie chains', () => {
    const tie = (t: string) => `<tie type="${t}"/>`;
    const nt = (t: string) => `<notations><tied type="${t}"/></notations>`;
    const m1 = ATTR() + TEMPO(60) + N(null, 2) + N(60, 2, tie('start') + nt('start'));
    const m2 = N(60, 4, tie('stop') + tie('start') + nt('stop') + nt('start'));
    const m3 = N(60, 1, tie('stop') + nt('stop')) + N(60, 1) + N(null, 2);
    const p = importMusicXml(score([{ measures: [m1, m2, m3] }]));
    expect(tuples(p.notes)).toEqual([
      [60, 2, 7],
      [60, 9, 1],
    ]);
  });

  it('tuplets come from the durations (triplet eighths, quintuplets)', () => {
    const tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
    const m1 = ATTR({ div: 15 }) + TEMPO(60) + [60, 62, 64].map((m) => N(m, 5, tm)).join('') + [65, 67, 69, 71, 72].map((m) => N(m, 3)).join('') + N(null, 30);
    const p = importMusicXml(score([{ measures: [m1] }]));
    expect(p.notes.map((n) => +n.start.toFixed(4))).toEqual([0, 0.3333, 0.6667, 1, 1.2, 1.4, 1.6, 1.8]);
  });

  it('grace notes: acciaccatura is short and delays the main note; appoggiatura takes half', () => {
    const m1 =
      ATTR({ div: 2 }) +
      TEMPO(60) +
      `<note><grace slash="yes"/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>` +
      N(72, 2, '<voice>1</voice>') +
      `<note><grace/><pitch><step>B</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type></note>` +
      N(72, 4, '<voice>1</voice>') +
      N(null, 2, '<voice>1</voice>');
    const p = importMusicXml(score([{ measures: [m1] }]));
    const [g1, m, g2, m2] = p.notes;
    expect(g1.midi).toBe(74);
    expect(g1.start).toBe(0);
    expect(g1.dur).toBeCloseTo(0.09, 3); // min(1/8 quarter, 90 ms) at 60 qpm
    expect(m.start).toBeCloseTo(0.09, 3);
    expect(m.start + m.dur).toBeCloseTo(1, 3);
    expect(g2.midi).toBe(71);
    expect(g2.start).toBeCloseTo(1, 3);
    expect(g2.dur).toBeCloseTo(1, 3); // half of the half note
    expect(m2.start).toBeCloseTo(2, 3);
    expect(m2.dur).toBeCloseTo(1, 3);
  });

  it('tempo: sound tempo, metronome marks (dotted units), tempo changes and tempo words; default 120', () => {
    const met = (unit: string, dot: boolean, pm: number) =>
      `<direction><direction-type><metronome><beat-unit>${unit}</beat-unit>${dot ? '<beat-unit-dot/>' : ''}<per-minute>${pm}</per-minute></metronome></direction-type></direction>`;
    const p = importMusicXml(score([{ measures: [ATTR() + met('half', false, 30) + N(60, 4), met('quarter', true, 40) + N(62, 4), words('Allegro') + N(64, 4), N(65, 4)] }]));
    // 60 qpm, then 60 qpm (dotted quarter = 40), then 132 qpm
    expect(p.notes.map((n) => +n.start.toFixed(3))).toEqual([0, 4, 8, +(8 + (4 * 60) / 132).toFixed(3)]);
    expect(p.tempo.bpm).toBe(60);
    // beat grid follows the tempo map
    expect(p.tempo.beats[8]).toBeCloseTo(8, 6);
    expect(p.tempo.beats[9]).toBeCloseTo(8 + 60 / 132, 6);
    const d = importMusicXml(score([{ measures: [ATTR() + N(60, 4)] }]));
    expect(d.notes[0].dur).toBe(2);
    expect(d.tempo.bpm).toBe(120);
  });

  it('time signatures: 6/8 beat grid in eighths, 3/4 pickup with a downbeat after it', () => {
    const p = importMusicXml(score([{ measures: [ATTR({ beats: 6, type: 8, div: 2 }) + TEMPO(60) + N(60, 6) + N(62, 6)] }]));
    expect(p.tempo).toMatchObject({ beatsPerBar: 6, beatUnit: 8, bpm: 120 });
    expect(p.tempo.beats[1]).toBeCloseTo(0.5, 6);
    // pickup of one quarter in 3/4
    const pick = score([
      {
        measures: [ATTR({ beats: 3 }) + TEMPO(60) + N(67, 1), N(72, 3), N(71, 2) + N(null, 1)],
      },
    ]).replace('<measure number="1">', '<measure number="0" implicit="yes">');
    const q = importMusicXml(pick);
    expect(tuples(q.notes).slice(0, 2)).toEqual([
      [67, 0, 1],
      [72, 1, 3],
    ]);
    expect(q.tempo.downbeatIndex).toBe(1);
    expect(q.tempo.beatsPerBar).toBe(3);
    // an eighth pickup in 4/4: half a beat of silence first so the grid starts on a beat
    const e = score([{ measures: [ATTR({ div: 2 }) + TEMPO(60) + N(67, 1), N(72, 8)] }]);
    const r = importMusicXml(e);
    expect(r.notes[0].start).toBeCloseTo(0.5, 6);
    expect(r.notes[1].start).toBeCloseTo(1, 6);
    expect(r.tempo.downbeatIndex).toBe(1);
  });

  it('warns when bar lines stop matching (time signature change)', () => {
    const p = importMusicXml(score([{ measures: [ATTR() + N(60, 4), ATTR({ beats: 3 }) + N(62, 3), N(64, 3)] }]));
    expect(p.warnings.join(' ')).toMatch(/From bar 3, the bar lines/);
  });

  it('key signature (concert pitch) and transposing instruments', () => {
    const clar =
      ATTR({ fifths: 2, extra: '<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>' }) + TEMPO(60) + N(62, 4); // written D5 → sounds C5
    const p = importMusicXml(score([{ name: 'Clarinet in B♭', measures: [clar] }]));
    expect(p.notes[0].midi).toBe(60);
    expect(p.key).toMatchObject({ tonic: 0, mode: 'major', fifths: 0 });
    // octave-change
    const bass = ATTR({ extra: '<transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>' }) + N(48, 4);
    expect(importMusicXml(score([{ name: 'Contrabass', measures: [bass] }])).notes[0].midi).toBe(36);
    expect(keyFromSignature(-3, 'minor')).toMatchObject({ tonic: 0, name: 'C minor', fifths: -3 });
    expect(keyFromSignature(4, 'major').name).toBe('E major');
  });

  it('octave marks (8va) don\'t change pitches (MusicXML pitches are the sounding ones)', () => {
    const oct = (t: string, size = 8) => `<direction><direction-type><octave-shift type="${t}" size="${size}"/></direction-type><staff>1</staff></direction>`;
    const m1 = ATTR({ div: 1, staves: 2 }) + TEMPO(60) + N(72, 1, '<staff>1</staff>') + oct('down') + N(72, 1, '<staff>1</staff>') + N(74, 1, '<staff>1</staff>') + oct('stop') + N(72, 1, '<staff>1</staff>') +
      '<backup><duration>4</duration></backup>' + N(48, 4, '<staff>2</staff>');
    const p = importMusicXml(score([{ measures: [m1] }]));
    expect(p.notes.filter((n) => n.hand === 'R').map((n) => n.midi)).toEqual([72, 72, 74, 72]);
    expect(p.notes.find((n) => n.hand === 'L')!.midi).toBe(48);
  });

  it('dynamics, accents and sf set velocities; pedal marks become pedal ranges', () => {
    const dyn = (d: string) => `<direction><direction-type><dynamics><${d}/></dynamics></direction-type></direction>`;
    const ped = (t: string) => `<direction><direction-type><pedal type="${t}"/></direction-type></direction>`;
    const m1 =
      ATTR() + TEMPO(60) + dyn('p') + ped('start') + N(60, 1) + N(62, 1, '<notations><articulations><accent/></articulations></notations>') + dyn('sfz') + N(64, 1) + ped('change') + N(65, 1);
    const m2 = dyn('ff') + N(67, 2) + ped('stop') + N(69, 2);
    const p = importMusicXml(score([{ measures: [m1, m2] }]));
    expect(p.notes.map((n) => n.vel)).toEqual([0.4, expect.closeTo(0.52, 5), 0.88, 0.4, 0.84, 0.84]);
    expect(p.pedal).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });

  it('fermatas hold longer (the following notes move later)', () => {
    const p = importMusicXml(score([{ measures: [ATTR() + TEMPO(60) + N(60, 2) + N(62, 2, '<notations><fermata/></notations>'), N(64, 4)] }]));
    expect(tuples(p.notes)).toEqual([
      [60, 0, 2],
      [62, 2, 3],
      [64, 5, 4],
    ]);
  });

  it('percussion parts are left out; several parts are combined and hands chosen by pitch', () => {
    const drums = '<attributes><divisions>1</divisions><clef><sign>percussion</sign></clef></attributes><note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>4</duration></note>';
    const p = importMusicXml(score([{ name: 'Flute', measures: [ATTR() + TEMPO(60) + N(79, 4)] }, { name: 'Cello', measures: [ATTR() + N(43, 4)] }, { name: 'Drum Set', measures: [drums] }]));
    expect(p.notes.map((n) => [n.midi, n.hand])).toEqual([
      [43, 'L'],
      [79, 'R'],
    ]);
    expect(p.handsKnown).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/drum part/);
    expect(p.warnings.join(' ')).toMatch(/3 parts|2 parts/);
    // a single melody line goes to one hand
    const solo = importMusicXml(score([{ name: 'Violin', measures: [ATTR() + TEMPO(60) + N(55, 1) + N(52, 1) + N(76, 2)] }]));
    expect(solo.notes.every((n) => n.hand === 'R')).toBe(true);
  });

  it('unisons between voices / parts become one note', () => {
    const m = ATTR({ staves: 1 }) + TEMPO(60) + N(60, 4, '<voice>1</voice>') + '<backup><duration>4</duration></backup>' + N(60, 2, '<voice>2</voice>') + N(null, 2, '<voice>2</voice>');
    const p = importMusicXml(score([{ measures: [m] }]));
    expect(tuples(p.notes)).toEqual([[60, 0, 4]]);
  });

  it('title, composer and movement', () => {
    const head = '<work><work-title>Sonata</work-title></work><movement-title>Allegro</movement-title><identification><creator type="composer">W. A. Mozart</creator></identification>';
    const p = importMusicXml(score([{ measures: [ATTR() + N(60, 4)] }], head));
    expect(p.title).toBe('Sonata — Allegro');
    expect(p.composer).toBe('W. A. Mozart');
  });

  it('score-timewise is converted', () => {
    const tw = `<?xml version="1.0"?><score-timewise version="4.0">${PART_LIST(['Piano'])}<measure number="1"><part id="P1">${ATTR() + TEMPO(60) + N(60, 4)}</part></measure><measure number="2"><part id="P1">${N(62, 4)}</part></measure></score-timewise>`;
    expect(tuples(importMusicXml(tw).notes)).toEqual([
      [60, 0, 4],
      [62, 4, 4],
    ]);
  });

  it('clear errors for files that are not scores', () => {
    expect(() => importMusicXml('<html><body/></html>')).toThrow(ScoreImportError);
    expect(() => importMusicXml('<score-partwise><part-list/></score-partwise>')).toThrow(/no parts/);
    expect(() => readScoreFile('a.musicxml', strToU8('hello'))).toThrow(/not MusicXML/);
    expect(isScoreFileName('Song.MXL')).toBe(true);
    expect(isScoreFileName('song.mid')).toBe(false);
  });
});

// ---------------------------------------------------------------- repeats

describe('repeats and jumps', () => {
  it('simple repeat, implicit start, and repeat times', () => {
    expect(playOrder(structure({ 2: back() }, 3))).toEqual(['1', '2', '1', '2', '3']);
    expect(playOrder(structure({ 2: fwd, 3: back(3) }, 4))).toEqual(['1', '2', '3', '2', '3', '2', '3', '4']);
    // a second repeat with no forward repeat goes back to the start; the first isn't taken again
    expect(playOrder(structure({ 1: back(), 3: back() }, 3))).toEqual(['1', '1', '2', '3', '1', '2', '3']);
    // ||: | :|| :|| — both go back to the forward repeat
    expect(playOrder(structure({ 2: fwd, 3: back(), 4: back() }, 5))).toEqual(['1', '2', '3', '2', '3', '4', '2', '3', '4', '5']);
  });
  it('volta endings 1 and 2', () => {
    const x = structure({ 1: fwd, 3: endStart('1') + endStop('1') + back(), 4: endStart('2') + endStop('2', 'discontinue') }, 5);
    expect(playOrder(x)).toEqual(['1', '2', '3', '1', '2', '4', '5']);
  });
  it('volta "1, 2" and "3" with a bracket over two measures', () => {
    const x = structure({ 2: endStart('1, 2'), 3: endStop('1, 2') + back(), 4: endStart('3') + endStop('3', 'discontinue') }, 5);
    expect(playOrder(x)).toEqual(['1', '2', '3', '1', '2', '3', '1', '4', '5']);
  });
  it('a first ending without a repeat sign implies one', () => {
    const x = structure({ 2: endStart('1') + endStop('1'), 3: endStart('2') + endStop('2', 'discontinue') }, 4);
    expect(playOrder(x)).toEqual(['1', '2', '1', '3', '4']);
  });
  it('a D.S. inside a repeated section is taken on its last pass', () => {
    const x = structure({ 3: fwd, 5: back() }, 6, { 2: words('Segno'), 4: words('D.S. al Fine') + '' });
    // (no Fine: plays to the end after the jump)
    expect(playOrder(x)).toEqual(['1', '2', '3', '4', '5', '3', '4', '2', '3', '4', '5', '6']);
  });
  it('D.C. al Fine (words) with repeats not taken again', () => {
    const x = structure({ 2: back() }, 4, { 2: words('Fine'), 4: words('D.C. al Fine') });
    expect(playOrder(x)).toEqual(['1', '2', '1', '2', '3', '4', '1', '2']);
  });
  it('D.S. al Coda with segno / To Coda / Coda from <sound>', () => {
    // (To Coda and D.S. after the measure's notes, segno and Coda before them)
    const x = structure({ 3: words('To Coda', '<sound tocoda="c1"/>'), 5: words('D.S. al Coda', '<sound dalsegno="s1"/>') }, 6, {
      2: words('', '<sound segno="s1"/>'),
      6: words('Coda', '<sound coda="c1"/>'),
    });
    expect(playOrder(x)).toEqual(['1', '2', '3', '4', '5', '2', '3', '6']);
    // a To Coda at the very start of a measure means after the previous one; a segno at the very end, from the next one
    const y = structure({ 1: words('', '<sound segno="s1"/>'), 5: words('D.S. al Coda') }, 6, { 4: words('To Coda'), 6: words('Coda') });
    expect(playOrder(y)).toEqual(['1', '2', '3', '4', '5', '2', '3', '6']);
  });
  it('D.S. al Coda with symbols only (segno, two coda signs)', () => {
    const sign = (t: string) => `<direction><direction-type><${t}/></direction-type></direction>`;
    const x = structure({}, 6, { 2: sign('segno'), 3: `${N(null, 0)}`.replace(/.*/, '') + sign('coda').replace('<direction>', '<direction placement="above">'), 5: words('D.S. al Coda'), 6: sign('coda') });
    // the first coda sign sits at the start of measure 3: "To Coda" after measure 2
    expect(playOrder(x)).toEqual(['1', '2', '3', '4', '5', '2', '6']);
  });
  it('numbered codas: D.S. al Coda II goes to To Coda II and Coda II', () => {
    const x = structure({ 3: words('To Coda I'), 4: words('To Coda II'), 5: words('D.S. al Coda I'), 7: words('D.S. al Coda II') }, 9, {
      1: words('Segno'),
      6: words('Coda I'),
      8: words('Coda II'),
    });
    expect(playOrder(x)).toEqual(['1', '2', '3', '4', '5', '1', '2', '3', '6', '7', '1', '2', '3', '4', '8', '9']);
  });
  it('D.C. with the last volta on the second pass', () => {
    const x = structure({ 1: fwd, 2: endStart('1') + endStop('1') + back(), 3: endStart('2') + endStop('2') }, 4, { 4: words('D.C.') });
    expect(playOrder(x)).toEqual(['1', '2', '1', '3', '4', '1', '3', '4']);
  });
  it('notes follow the performance order (unrolled timing)', () => {
    const p = importMusicXml(structure({ 2: back() }, 3));
    expect(p.notes.map((n) => [n.midi, n.start])).toEqual([
      [60, 0],
      [61, 4],
      [60, 8],
      [61, 12],
      [62, 16],
    ]);
    expect(p.measures).toEqual({ written: 3, played: 5 });
  });
  it('helpers: words, ending numbers, tempo words', () => {
    expect(jumpFromWords('D.S. al Coda')).toEqual({ jump: { to: 'segno', alFine: false, alCoda: true } });
    expect(jumpFromWords('Da Capo al Fine')).toEqual({ jump: { to: 'start', alFine: true, alCoda: false } });
    expect(jumpFromWords('To Coda')).toEqual({ toCoda: true });
    expect(jumpFromWords('To Coda II')).toEqual({ toCoda: true, id: 'ii' });
    expect(jumpFromWords('D.$. al Coda')).toEqual({ jump: { to: 'segno', alFine: false, alCoda: true } });
    expect(jumpFromWords('Ø Coda')).toEqual({ coda: true });
    expect(jumpFromWords('Fine')).toEqual({ fine: true });
    expect(jumpFromWords('dolce')).toBeNull();
    expect(parseEndingNumbers('1, 2')).toEqual([1, 2]);
    expect(parseEndingNumbers('1-3')).toEqual([1, 2, 3]);
    expect(parseEndingNumbers('2.')).toEqual([2]);
    expect(tempoFromWords('Allegro ma non troppo')).toBe(132);
    expect(tempoFromWords('Andantino')).toBe(84);
    expect(tempoFromWords('dolce')).toBeNull();
  });
  it('never loops forever', () => {
    const ms: IRMeasure[] = [0, 1].map((i) => ({ label: String(i), length: 4, beats: 4, beatType: 4, tempos: [], notes: [], dynamics: [], pedal: [], fermatas: [], repeatEnd: 1e9 }));
    const r = unroll(ms);
    expect(r.order.length).toBeLessThanOrEqual(20000);
  });
});

// ---------------------------------------------------------------- .mxl

describe('.mxl', () => {
  const xml = score([{ measures: [ATTR() + TEMPO(60) + N(60, 4)] }], '<work><work-title>Zipped</work-title></work>');
  it('reads the root file named in META-INF/container.xml', () => {
    const zip = zipSync({
      mimetype: strToU8('application/vnd.recordare.musicxml'),
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/piece.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
      'score/piece.musicxml': strToU8(xml),
      'score/other.xml': strToU8('<nothing/>'),
    });
    const p = readScoreFile('piece.mxl', zip);
    expect(p.title).toBe('Zipped');
    expect(p.format).toBe('mxl');
    expect(p.notes).toHaveLength(1);
  });
  it('falls back to the first .xml file and reports damaged archives', () => {
    expect(readScoreFile('x.mxl', zipSync({ 'a.xml': strToU8(xml) })).notes).toHaveLength(1);
    expect(() => readScoreFile('x.mxl', new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]))).toThrow(/damaged/);
  });
});

// ---------------------------------------------------------------- round trip through our own writer

/** The chords our writer puts on paper, as notes in quarters (ties merged = whole chords). */
function writtenNotes(sc: Score): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const sv of sc.staves) for (const v of sv.voices) for (const c of v) for (const m of c.midis) out.push([m, c.on / DIV, c.off / DIV]);
  return dedupeSorted(out);
}
function dedupeSorted(xs: [number, number, number][]): [number, number, number][] {
  xs.sort((a, b) => a[1] - b[1] || a[0] - b[0] || b[2] - a[2]);
  const out: [number, number, number][] = [];
  for (const x of xs) {
    const p = out.find((o) => o[0] === x[0] && Math.abs(o[1] - x[1]) < 1e-6);
    if (p) continue;
    // a still-held same pitch is cut where the key is struck again (like the importer)
    const held = out.filter((o) => o[0] === x[0] && o[2] > x[1] + 1e-9);
    for (const h of held) h[2] = x[1];
    out.push(x);
  }
  return out;
}

export function roundTrip(sc: Score, title = 'Round trip'): { written: [number, number, number][]; read: [number, number, number][]; xml: string } {
  const xml = toMusicXml(sc, { title, credits: true, date: '2026-01-01' });
  const ir = musicXmlToIR(xml);
  const { perf } = scoreTiming(ir);
  const read = dedupeSorted(perf.notes.map((n) => [n.midi, n.on, n.off]));
  return { written: writtenNotes(sc), read, xml };
}

describe('round trip: our MusicXML writer → importer', () => {
  const tempo = (bpm: number, over: Partial<TempoInfo> = {}): TempoInfo => ({ bpm, beats: regularBeats(bpm, 0, 200), beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'midi', ...over });

  it('demo song (Bach prelude), every level: same pitches, onsets and lengths; seconds match the sheet time map', () => {
    const d = bachPreludeDemo();
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const sc = buildScore({ notes: d.notes, tempo: d.tempo, key: { tonic: 0, mode: 'major' }, duration: d.duration, level });
      const { written, read, xml } = roundTrip(sc);
      expect(read.length).toBe(written.length);
      for (let i = 0; i < read.length; i++) {
        expect(read[i][0]).toBe(written[i][0]);
        expect(read[i][1]).toBeCloseTo(written[i][1], 6);
        expect(read[i][2]).toBeCloseTo(written[i][2], 6);
      }
      // seconds: the imported song lands on the original song's time map
      const p = importMusicXml(xml);
      expect(p.notes.length).toBe(written.length);
      for (const n of p.notes.slice(0, 50)) {
        const w = written.find((x) => x[0] === n.midi && Math.abs(sc.time.posToTime(x[1] * DIV) - n.start) < 1e-3);
        expect(w).toBeTruthy();
      }
      expect(p.tempo.bpm).toBe(66);
      expect(p.key).toMatchObject({ tonic: 0, mode: 'major' });
      expect(p.handsKnown).toBe(true);
    }
  });

  it('random songs with pickups, triplets, two voices, ottavas and tempo changes', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 6; trial++) {
      const bpm = 60 + Math.round(rnd() * 80);
      const meter = trial % 3 === 0 ? { beatsPerBar: 3 } : trial % 3 === 1 ? { beatsPerBar: 6, beatUnit: 8 as const } : { beatsPerBar: 4 };
      const t = tempo(bpm, meter);
      const beat = 60 / bpm;
      const notes: Note[] = [];
      let id = 1;
      for (let k = 0; k < 160; k++) {
        const grid = trial % 2 ? 3 : 4;
        const start = beat * (Math.floor(rnd() * 40 * grid) / grid) + (trial === 2 ? beat * 0.5 : 0);
        const dur = beat * (1 + Math.floor(rnd() * 6)) / grid;
        const hand = rnd() < 0.5 ? 'L' : 'R';
        const midi = hand === 'R' ? 60 + Math.floor(rnd() * 40) : 24 + Math.floor(rnd() * 36);
        notes.push({ id: id++, midi, start, dur, vel: 0.7, hand });
      }
      const duration = Math.max(...notes.map((n) => n.start + n.dur)) + 1;
      const sc = buildScore({ notes, tempo: t, key: { tonic: trial, mode: 'major' }, duration, level: 'hard' });
      const { written, read } = roundTrip(sc);
      expect(read.length).toBe(written.length);
      const bad = read.filter((r, i) => r[0] !== written[i][0] || Math.abs(r[1] - written[i][1]) > 1e-6 || Math.abs(r[2] - written[i][2]) > 1e-6);
      expect(bad).toEqual([]);
    }
  });

  it('songFromScore builds a Song with an exact transcription and generated Easy / Medium', () => {
    const d = bachPreludeDemo();
    const sc = buildScore({ notes: d.notes, tempo: d.tempo, key: { tonic: 0, mode: 'major' }, duration: d.duration, level: 'hard' });
    const xml = toMusicXml(sc, { title: 'Prelude', artist: 'J. S. Bach', credits: true });
    const parsed = importMusicXml(xml, { fileName: 'prelude.musicxml' });
    const song = songFromScore(parsed, { kind: 'score', fileName: 'prelude.musicxml', fileSize: xml.length });
    expect(song.title).toBe('Prelude');
    expect(song.artist).toBe('J. S. Bach');
    expect(song.source.kind).toBe('score');
    expect(song.transcription).toMatchObject({ method: 'score-file', estimated: false, handsFromScore: true });
    expect(song.arrangements.hard.notes.length).toBe(parsed.notes.length);
    expect(song.arrangements.easy.notes.length).toBeGreaterThan(0);
    expect(song.arrangements.easy.notes.length).toBeLessThan(parsed.notes.length);
    expect(song.arrangements.medium.notes.length).toBeGreaterThan(0);
    // hands as written on Hard
    expect(song.arrangements.hard.notes.map((n) => n.hand)).toEqual(song.base.map((n) => n.hand));
  });
});

// ---------------------------------------------------------------- MuseScore

/** A MuseScore file: parts (instrument id, staves) and, per staff, measures of voices. */
function mscx(o: { version?: string; parts?: { id: string; staves: number; drums?: boolean }[]; staves: string[][]; extra?: string; meta?: string }): string {
  const parts = o.parts ?? [{ id: 'piano', staves: o.staves.length }];
  return `<?xml version="1.0" encoding="UTF-8"?><museScore version="${o.version ?? '4.20'}"><Score><Division>480</Division>${o.meta ?? ''}${parts
    .map(
      (p) =>
        `<Part><Instrument id="${p.id}"><longName>${p.id}</longName><instrumentId>${p.id === 'piano' ? 'keyboard.piano' : p.id}</instrumentId>${p.drums ? '<useDrumset>1</useDrumset>' : ''}</Instrument>${'<Staff><StaffType group="pitched"/></Staff>'.repeat(p.staves)}</Part>`,
    )
    .join('')}${o.staves.map((ms, i) => `<Staff id="${i + 1}">${ms.map((m) => (m.startsWith('<Measure') ? m : `<Measure>${m}</Measure>`)).join('')}</Staff>`).join('')}${o.extra ?? ''}</Score></museScore>`;
}
const V = (...xs: string[]) => `<voice>${xs.join('')}</voice>`;
const C = (dur: string, pitches: number[], inner = '', noteInner: (p: number) => string = () => '') =>
  `<Chord>${inner}<durationType>${dur}</durationType>${pitches.map((p) => `<Note>${noteInner(p)}<pitch>${p}</pitch></Note>`).join('')}</Chord>`;
const R = (dur: string) => `<Rest><durationType>${dur}</durationType></Rest>`;
const TS = (n: number, d: number) => `<TimeSig><sigN>${n}</sigN><sigD>${d}</sigD></TimeSig>`;
const MTEMPO = (qpm: number) => `<Tempo><tempo>${qpm / 60}</tempo></Tempo>`;

describe('MuseScore files', () => {
  it('notes, chords, rests, voices, two staves → hands, tempo and title', () => {
    const x = mscx({
      meta: '<metaTag name="workTitle">Little Piece</metaTag><metaTag name="composer">Someone</metaTag>',
      staves: [
        [V(TS(4, 4), MTEMPO(60), C('quarter', [72]), R('quarter'), C('half', [76, 79])) + V(R('half'), C('half', [67]))],
        [V(TS(4, 4), C('whole', [48]))],
      ],
    });
    const p = readScoreFile('piece.mscx', strToU8(x));
    expect(p.title).toBe('Little Piece');
    expect(p.composer).toBe('Someone');
    expect(p.format).toBe('mscx');
    expect(tuples(p.notes)).toEqual([
      [48, 0, 4],
      [72, 0, 1],
      [67, 2, 2],
      [76, 2, 2],
      [79, 2, 2],
    ]);
    expect(p.notes.find((n) => n.midi === 48)!.hand).toBe('L');
    expect(p.handsKnown).toBe(true);
  });

  it('dots, tuplets (nested), measure rests and irregular measures', () => {
    const tup = (n: number, a: number) => `<Tuplet><normalNotes>${n}</normalNotes><actualNotes>${a}</actualNotes><baseNote>eighth</baseNote></Tuplet>`;
    const x = mscx({
      staves: [
        [
          `<Measure len="1/4">${V(TS(4, 4), MTEMPO(60), C('quarter', [67]))}</Measure>`,
          V(C('quarter', [60], '<dots>1</dots>'), C('eighth', [62]), tup(2, 3), C('eighth', [64]), C('eighth', [65]), C('eighth', [67]), '<endTuplet/>', R('quarter')),
          V('<Rest><durationType>measure</durationType><duration>4/4</duration></Rest>'),
          V(C('whole', [72])),
        ],
      ],
    });
    const p = readScoreFile('a.mscx', strToU8(x));
    expect(p.notes.map((n) => [n.midi, +n.start.toFixed(4)])).toEqual([
      [67, 0],
      [60, 1],
      [62, 2.5],
      [64, 3],
      [65, 3.3333],
      [67, 3.6667],
      [72, 9],
    ]);
    expect(p.tempo.downbeatIndex).toBe(1);
  });

  it('ties: old <Spanner type="Tie"> and new <Tie> with element ids', () => {
    const tieNext = '<Spanner type="Tie"><Tie/><next><location><fractions>1/4</fractions></location></next></Spanner>';
    const tiePrev = '<Spanner type="Tie"><prev><location><fractions>-1/4</fractions></location></prev></Spanner>';
    const old = mscx({ version: '3.02', staves: [[V(TS(4, 4), MTEMPO(60), R('half'), C('quarter', [60], '', () => tieNext), C('quarter', [60], '', () => tiePrev + tieNext)), V(C('quarter', [60], '', () => tiePrev), R('quarter'), R('half'))]] });
    expect(tuples(readScoreFile('a.mscx', strToU8(old)).notes)).toEqual([[60, 2, 3]]);
    const neu = mscx({
      version: '5.00',
      staves: [[V(TS(4, 4), MTEMPO(60), R('half'), `<Chord><durationType>half</durationType><Note><eid>A</eid><pitch>64</pitch></Note></Chord>`), V(`<Chord><durationType>quarter</durationType><Note><eid>B</eid><Tie><startElement>A</startElement><endElement>B</endElement></Tie><pitch>64</pitch></Note></Chord>`, R('quarter'), R('half'))]],
    });
    expect(tuples(readScoreFile('a.mscx', strToU8(neu)).notes)).toEqual([[64, 2, 3]]);
  });

  it('octave lines (in a voice, or in the score-wide SpannerMap) and pedal', () => {
    const ott = '<Spanner type="Ottava"><Ottava><subtype>8va</subtype></Ottava><next><location><fractions>1/2</fractions></location></next></Spanner>';
    const ped = '<Spanner type="Pedal"><Pedal/><next><location><measures>1</measures></location></next></Spanner>';
    const a = mscx({ staves: [[V(TS(4, 4), MTEMPO(60), ped, ott, C('quarter', [72]), C('quarter', [72]), C('half', [72])), V(C('whole', [60]))]] });
    const p = readScoreFile('a.mscx', strToU8(a));
    expect(p.notes.map((n) => n.midi)).toEqual([84, 84, 72, 60]);
    expect(p.pedal).toEqual([{ start: 0, end: 4 }]);
    const b = mscx({
      version: '5.00',
      staves: [[V(TS(4, 4), MTEMPO(60), C('quarter', [60]), C('quarter', [60]), C('half', [60]))]],
      extra: '<SpannerMap><Ottava><subtype>8vb</subtype><startTick>1/4</startTick><ticks>1/4</ticks><track>0</track></Ottava></SpannerMap>',
    });
    expect(readScoreFile('b.mscx', strToU8(b)).notes.map((n) => n.midi)).toEqual([60, 48, 60]);
  });

  it('grace notes, accents, dynamics and drums', () => {
    const x = mscx({
      parts: [
        { id: 'piano', staves: 1 },
        { id: 'drumset', staves: 1, drums: true },
      ],
      staves: [
        [V(TS(4, 4), MTEMPO(60), '<Dynamic><subtype>p</subtype><velocity>49</velocity></Dynamic>', C('eighth', [74], '<acciaccatura/>'), C('quarter', [72]), C('quarter', [72], '<Articulation><subtype>articAccentAbove</subtype></Articulation>'), R('half'))],
        [V(TS(4, 4), C('whole', [36]))],
      ],
    });
    const p = readScoreFile('a.mscx', strToU8(x));
    expect(p.notes.map((n) => n.midi)).toEqual([74, 72, 72]);
    expect(p.notes[0].dur).toBeCloseTo(0.09, 3);
    expect(p.notes[1].start).toBeCloseTo(0.09, 3);
    expect(p.notes[1].vel).toBeCloseTo(49 / 127, 3);
    expect(p.notes[2].vel).toBeCloseTo(49 / 127 + 0.12, 3);
    expect(p.warnings.join(' ')).toMatch(/drum/);
  });

  it('repeats, voltas, markers and jumps', () => {
    const volta = (e: string, measures: number) => `<Spanner type="Volta"><Volta><endings>${e}</endings></Volta><next><location><measures>${measures}</measures></location></next></Spanner>`;
    const m = (k: number, inner = '', outer = '') => `<Measure>${outer}${V(k === 1 ? TS(4, 4) + MTEMPO(60) : '', inner, C('whole', [59 + k]))}</Measure>`;
    const x = mscx({
      staves: [
        [
          m(1),
          m(2, '', '<Marker><label>segno</label><markerType>segno</markerType></Marker><startRepeat/>'),
          m(3, volta('1', 1), '<endRepeat>2</endRepeat>'),
          m(4, volta('2', 1), '<Marker><label>coda</label><markerType>coda</markerType></Marker>'),
          m(5, '', '<Jump><jumpTo>segno</jumpTo><playUntil>coda</playUntil><continueAt>codab</continueAt></Jump>'),
          m(6, '', '<Marker><label>codab</label><markerType>codab</markerType></Marker>'),
        ],
      ],
    });
    const p = readScoreFile('a.mscx', strToU8(x));
    expect(p.notes.map((n) => n.midi - 59)).toEqual([1, 2, 3, 2, 4, 5, 2, 4, 6]);
  });

  it('.mscz, MuseScore 2 files and damaged files tell the user to export MusicXML', () => {
    const x = mscx({ staves: [[V(TS(4, 4), C('whole', [60]))]] });
    const z = zipSync({ 'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.mscx"/></rootfiles></container>'), 'score.mscx': strToU8(x), 'Thumbnails/thumbnail.png': new Uint8Array([1, 2, 3]) });
    expect(readScoreFile('Song.mscz', z).notes).toHaveLength(1);
    expect(readScoreFile('Song.mscz', z).format).toBe('mscz');
    expect(() => readScoreFile('old.mscx', strToU8('<museScore version="2.06"><Score/></museScore>'))).toThrow(/MuseScore 2[\s\S]*File → Export → MusicXML/);
    expect(() => readScoreFile('x.mscz', zipSync({ 'a.txt': strToU8('x') }))).toThrow(/Export → MusicXML/);
  });
});
