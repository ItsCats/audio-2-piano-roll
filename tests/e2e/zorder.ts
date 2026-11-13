// Dev-only harness: draw order of overlapping falling notes (newer notes must sit on top).
// Open /tests/e2e/zorder.html?t=2.05 (optional &theme=<id>&range=auto). Sets window.__ready.
import { PianoRollRenderer } from '../../src/lib/render/renderer';
import { DEFAULT_VISUAL, applyTheme, type VisualSettings } from '../../src/lib/render/settings';
import type { Note } from '../../src/lib/music/types';

const q = new URLSearchParams(location.search);
const t = Number(q.get('t') ?? '2.05');

// synthetic song: long held notes with newer notes falling onto the same / neighbouring keys
let id = 1;
const notes: Note[] = [];
const add = (midi: number, start: number, dur: number, hand: 'L' | 'R') => notes.push({ id: id++, midi, start, dur, vel: 0.8, hand });
// RH: long old C#5 (black) with new C5 / D5 (white) falling onto the neighbouring keys
add(73, 0.5, 3.6, 'R');
for (const [i, m] of [72, 74, 72, 74].entries()) add(m, 2.35 + i * 0.45, 0.35, 'R');
// RH: E5 re-struck before the old one has ended (same-pitch overlap)
add(76, 0.8, 2.6, 'R');
add(76, 2.5, 1.2, 'R');
// RH chord with adjacent white + black keys at the same time (black should sit on top)
for (const m of [79, 80, 81]) add(m, 3.75, 0.8, 'R');
// LH: held chord F#3 A3 C#4, newer G3 / B3 / C4 / D4 falling next to it
for (const m of [54, 57, 61]) add(m, 1.0, 3.2, 'L');
add(55, 2.6, 0.5, 'L');
add(59, 3.0, 0.5, 'L');
add(60, 3.4, 0.5, 'L');
add(62, 2.8, 0.5, 'L');
// LH: long old white E3 with a newer black D#3 / F3 falling next to it
add(52, 0.6, 3.6, 'L');
add(51, 2.7, 0.4, 'L');
add(53, 3.3, 0.4, 'L');

let visual: VisualSettings = { ...DEFAULT_VISUAL, range: (q.get('range') as VisualSettings['range']) ?? 'auto' };
const theme = q.get('theme');
if (theme) visual = { ...applyTheme(visual, theme), range: visual.range };

const canvas = document.getElementById('c') as HTMLCanvasElement;
const r = new PianoRollRenderer(canvas, visual);
r.setNotes(notes, [], null);
const dpr = window.devicePixelRatio || 1;
r.resize(window.innerWidth * dpr, window.innerHeight * dpr);
r.render({ time: t });
(window as unknown as { __ready: boolean }).__ready = true;
