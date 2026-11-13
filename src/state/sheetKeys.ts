/**
 * Keyboard shortcuts of the sheet music in Edit mode, as a pure key → action map (Settings lists
 * them). The Studio's handler asks this first while the sheet is being edited; keys it doesn't map
 * (Space, F, E, Home) keep their usual meaning. Inputs and dialogs are ignored by the caller
 * (studioKeys.ts shouldHandleGlobalKey).
 */
export type SheetAction =
  | { type: 'pitch'; kind: 'step' | 'octave' | 'semi'; dir: 1 | -1 }
  | { type: 'move'; dir: 1 | -1; beat: boolean }
  | { type: 'selectNext'; dir: 1 | -1 }
  | { type: 'seek'; dir: 1 | -1; small: boolean }
  | { type: 'length'; step: 1 | -1 }
  | { type: 'dot' }
  | { type: 'triplet' }
  | { type: 'addMode' }
  | { type: 'escape' }
  | { type: 'delete' }
  | { type: 'hand'; hand: 'L' | 'R' | 'toggle' }
  | { type: 'tie' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'selectAll' }
  | { type: 'quantize' }
  | { type: 'finger'; finger: 0 | 1 | 2 | 3 | 4 | 5 }
  | { type: 'art'; art: 'staccato' | 'accent' | 'tenuto' | 'marcato' }
  | { type: 'slur' }
  | { type: 'wedge'; dir: 'cresc' | 'dim' }
  | { type: 'pedal' }
  | { type: 'picker'; picker: 'dyn' | 'text' | 'key' | 'time' | 'tempo' }
  | { type: 'help' };

export interface SheetKeyLike {
  code: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The action of a key press on the sheet in Edit mode, or null (not a sheet key). */
export function sheetKeyAction(e: SheetKeyLike, hasSelection: boolean): SheetAction | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.code === 'KeyZ') return e.shiftKey ? { type: 'redo' } : { type: 'undo' };
    if (e.code === 'KeyY') return { type: 'redo' };
    if (e.code === 'KeyA') return { type: 'selectAll' };
    return null;
  }
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) return { type: 'help' };
  if (e.key === '<' || (e.code === 'Comma' && e.shiftKey)) return { type: 'wedge', dir: 'cresc' };
  if (e.key === '>' || (e.code === 'Period' && e.shiftKey)) return { type: 'wedge', dir: 'dim' };
  const digit = /^Digit([0-5])$/.exec(e.code);
  if (digit && !e.altKey && !e.shiftKey) return { type: 'finger', finger: Number(digit[1]) as 0 | 1 | 2 | 3 | 4 | 5 };
  if (e.altKey && e.code !== 'Digit3' && !e.code.startsWith('Arrow')) return null;
  switch (e.code) {
    case 'KeyS':
      return e.shiftKey ? { type: 'slur' } : { type: 'art', art: 'staccato' };
    case 'KeyA':
      return { type: 'art', art: e.shiftKey ? 'marcato' : 'accent' };
    case 'KeyU':
      return e.shiftKey ? null : { type: 'art', art: 'tenuto' };
    case 'KeyP':
      return e.shiftKey ? null : { type: 'pedal' };
    case 'KeyD':
      return e.shiftKey ? null : { type: 'picker', picker: 'dyn' };
    case 'KeyW':
      return e.shiftKey ? null : { type: 'picker', picker: 'text' };
    case 'KeyK':
      return e.shiftKey ? null : { type: 'picker', picker: 'key' };
    case 'KeyM':
      return e.shiftKey ? null : { type: 'picker', picker: 'time' };
    case 'ArrowUp':
    case 'ArrowDown': {
      const dir = e.code === 'ArrowUp' ? 1 : -1;
      if (!hasSelection) return null;
      return { type: 'pitch', kind: e.shiftKey ? 'octave' : e.altKey ? 'semi' : 'step', dir };
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      if (e.altKey) return { type: 'selectNext', dir };
      if (!hasSelection) return { type: 'seek', dir, small: e.shiftKey };
      return { type: 'move', dir, beat: e.shiftKey };
    }
    case 'BracketLeft':
      return { type: 'length', step: -1 };
    case 'BracketRight':
      return { type: 'length', step: 1 };
    case 'Period':
    case 'NumpadDecimal':
      return e.altKey ? null : { type: 'dot' };
    case 'Digit3':
      return e.altKey ? { type: 'triplet' } : null;
    case 'KeyN':
      return e.altKey ? null : { type: 'addMode' };
    case 'Escape':
      return { type: 'escape' };
    case 'Delete':
    case 'Backspace':
      return { type: 'delete' };
    case 'KeyH':
      return e.altKey ? null : { type: 'hand', hand: 'toggle' };
    case 'KeyL':
      return e.altKey ? null : { type: 'hand', hand: 'L' };
    case 'KeyR':
      return e.altKey ? null : { type: 'hand', hand: 'R' };
    case 'KeyT':
      return e.altKey ? null : e.shiftKey ? { type: 'picker', picker: 'tempo' } : { type: 'tie' };
    case 'KeyQ':
      return { type: 'quantize' };
  }
  return null;
}

/** The shortcut list shown in Settings (Sheet music, Edit mode). */
export const SHEET_SHORTCUTS: [string, string][] = [
  ['Click / Shift+click', 'Select a note / add to the selection'],
  ['Drag on empty paper', 'Select the notes in a box'],
  ['Drag a selected note', 'Move it (up/down: pitch, sideways: time)'],
  ['Double-click a staff', 'Add a note there'],
  ['N', 'Add mode on/off (click to place notes)'],
  ['↑ / ↓', 'Up / down one step in the key'],
  ['Shift+↑ / ↓', 'Up / down an octave'],
  ['Alt+↑ / ↓', 'Sharp / flat (one semitone)'],
  ['← / →', 'Earlier / later by a grid step (Shift: a beat); no selection: seek'],
  ['Alt+← / →', 'Select the previous / next note'],
  ['[ / ]', 'Shorter / longer'],
  ['.', 'Dot on/off'],
  ['Alt+3', 'Triplet on/off'],
  ['H / L / R', 'Swap hands / left hand / right hand'],
  ['T', 'Tie / untie'],
  ['Del / Backspace', 'Delete'],
  ['Esc', 'Leave Add mode, then clear the selection'],
  ['1–5 / 0', 'Fingering / clear it'],
  ['S / A / U / Shift+A', 'Staccato / accent / tenuto / marcato'],
  ['Shift+S', 'Slur over the selection'],
  ['< / >', 'Crescendo / diminuendo over the selection'],
  ['D', 'Dynamics (← / → choose, Enter applies)'],
  ['P', 'Pedal over the selection'],
  ['W', 'Words (text)'],
  ['K / M / Shift+T', 'Key / time signature / tempo from this bar'],
  ['Click a marking', 'Select it: Del removes it, ← / → move it (Shift: its end)'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+A', 'Select all'],
  ['?', 'Help and shortcuts'],
];

/** Runs sheet actions; set by the sheet view while it is mounted (it loads with the notation code). */
let handler: ((a: SheetAction) => boolean) | null = null;
export function setSheetActionHandler(h: ((a: SheetAction) => boolean) | null): void {
  handler = h;
}
export const sheetActionHandler = () => handler;
