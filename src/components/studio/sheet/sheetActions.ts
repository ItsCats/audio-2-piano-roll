/**
 * Sheet edit actions shared by the keyboard (state/sheetKeys.ts), the edit bar and the context
 * menu: each runs a sheet operation on the current selection as one undo step.
 */
import { addBarOp, deleteOp, handOp, lengthOp, moveOp, pitchOp, tieOp, type LengthChange } from '../../../lib/sheet/edit';
import { writtenIndex } from '../../../lib/sheet/written';
import { buildSheet } from '../../../lib/sheet';
import { audition, runSheetEdit, sheetCtx } from '../../../state/sheetEdit';
import type { SheetAction } from '../../../state/sheetKeys';
import { useSheetUi } from '../../../state/sheetUi';
import { currentArrangement, useStudio } from '../../../state/studioStore';
import { getPlayer } from '../../../state/playback';
import { toast } from '../../../state/toastStore';
import { articulationOp, dynamicOp, fingerOp, pedalOp, resolveMark, slurOp, textOp, updateMarkOp, wedgeOp } from '../../../lib/sheet/marks';
import { cursorMeasure, deleteSelectedMark, moveSelectedMark, runMarkEdit } from '../../../state/sheetMarks';
import { easyMediumFromHard } from '../../../lib/songs';
import type { Articulation, DynamicValue, SheetMark } from '../../../lib/music/types';
import { DYNAMIC_VALUES } from '../../../lib/music/types';

const sel = () => useStudio.getState().selection;
const selectedMidis = () => {
  const arr = currentArrangement(useStudio.getState());
  const s = sel();
  return arr ? arr.notes.filter((n) => s.has(n.id)).map((n) => n.midi) : [];
};

export const sheetEdit = {
  pitch: (kind: 'step' | 'octave' | 'semi', dir: 1 | -1) => {
    if (runSheetEdit((c) => pitchOp(c, sel(), kind, dir), { coalesceKey: `sheet-pitch-${kind}` })) audition(selectedMidis());
  },
  move: (dir: 1 | -1, beat = false) => runSheetEdit((c) => moveOp(c, sel(), dir, beat), { coalesceKey: 'sheet-move' }),
  length: (ch: LengthChange) => runSheetEdit((c) => lengthOp(c, sel(), ch), { coalesceKey: 'sheet-length' }),
  remove: () => runSheetEdit((c) => deleteOp(c, sel())),
  hand: (h: 'L' | 'R' | 'toggle') => runSheetEdit((c) => handOp(c, sel(), h)),
  tie: () => {
    if (!runSheetEdit((c) => tieOp(c, sel()))) toast.info('Select two notes of the same pitch next to each other to tie them, or a tied note to untie it.');
  },
  addBar: () => runSheetEdit((c) => addBarOp(c)),
};

const needSel = () => {
  if (sel().size) return true;
  toast.info('Select a note first.');
  return false;
};
const bake = () => useSheetUi.getState().bake;
/** The selected marking of the given kind, if any. */
function selectedMark<K extends SheetMark['kind']>(kind: K): Extract<SheetMark, { kind: K }> | null {
  const ctx = sheetCtx();
  const r = ctx ? resolveMark(ctx, useStudio.getState().markSel) : null;
  return r?.type === 'mark' && r.mark.kind === kind ? (r.mark as Extract<SheetMark, { kind: K }>) : null;
}

/** Markings on the selection (or at the playback cursor when nothing is selected). */
export const sheetMark = {
  finger: (f: 0 | 1 | 2 | 3 | 4 | 5) => needSel() && runMarkEdit((c) => fingerOp(c, sel(), f)),
  art: (a: Articulation) => needSel() && runMarkEdit((c) => articulationOp(c, sel(), a)),
  slur: () => {
    if (!needSel()) return false;
    const ok = runMarkEdit((c) => slurOp(c, sel()));
    if (!ok) toast.info('Select two or more notes of one hand to slur them.');
    return ok;
  },
  /** A dynamic (or a new value for the selected one). */
  dyn: (value: DynamicValue) => {
    const cur = selectedMark('dyn');
    if (cur) return runMarkEdit((c) => updateMarkOp(c, cur.id, { value }, { bake: bake() }));
    return runMarkEdit((c) => dynamicOp(c, sel(), value, { bake: bake(), cursorMeasure: cursorMeasure(c) }));
  },
  /** A hairpin over the selection (a selected hairpin: its direction changes). */
  wedge: (dir: 'cresc' | 'dim') => {
    const cur = selectedMark('wedge');
    if (cur) return runMarkEdit((c) => updateMarkOp(c, cur.id, { dir }, { bake: bake() }));
    return runMarkEdit((c) => wedgeOp(c, sel(), dir, { bake: bake(), cursorMeasure: cursorMeasure(c) }));
  },
  pedal: () => runMarkEdit((c) => pedalOp(c, sel(), cursorMeasure(c))),
  /** Pedal marks on this level's sheet on / off. */
  showPedal: (on: boolean) => runMarkEdit(() => ({ showPedal: on })),
  /** Words (or new words / placement for the selected text). */
  text: (text: string, o: { above: boolean; style: 'italic' | 'bold' | null }) => {
    const cur = selectedMark('text');
    if (cur) return runMarkEdit((c) => updateMarkOp(c, cur.id, { text, above: o.above, style: o.style ?? undefined }));
    return runMarkEdit((c) => textOp(c, sel(), text, { above: o.above, style: o.style, cursorMeasure: cursorMeasure(c) }));
  },
  remove: () => deleteSelectedMark(),
  copyFixes: () => {
    const st = useStudio.getState();
    if (!st.song) return;
    const fixed = st.song.arrangements.easy.edited || st.song.arrangements.medium.edited;
    if (!confirm(`Copy your Hard fixes and markings to Easy and Medium? Easy and Medium are rebuilt from Hard.${fixed ? ' Fixes made on Easy and Medium will be replaced.' : ''}`)) return;
    st.replaceSong(easyMediumFromHard(st.song));
    toast.success('Copied to Easy & Medium', 'Easy and Medium were rebuilt from Hard, with its fingering and markings.');
  },
};

/** The dynamics of the picker, in order (the first six are shown, the rest behind "More"). */
export const DYN_ORDER: DynamicValue[] = DYNAMIC_VALUES;

/** The previous / next written note on the staff of the selection (Alt+← / →). */
export function selectNeighbor(dir: 1 | -1): void {
  const st = useStudio.getState();
  if (!st.song) return;
  const score = buildSheet(st.song, st.difficulty);
  const idx = writtenIndex(score);
  const firsts = [...idx.byKey.values()].filter((w) => w.first).sort((a, b) => a.pieceOn - b.pieceOn || a.midi - b.midi);
  if (!firsts.length) return;
  const cur = [...st.selection].map((id) => idx.byId.get(id)?.[0]).filter(Boolean);
  const ref = cur.length ? cur.reduce((a, b) => (dir > 0 ? (b!.pieceOn > a!.pieceOn ? b : a) : b!.pieceOn < a!.pieceOn ? b : a))! : null;
  const staff = ref?.staff ?? 1;
  const list = firsts.filter((w) => w.staff === staff);
  let next;
  if (!ref) next = dir > 0 ? list[0] : list[list.length - 1];
  else {
    // the next onset on the staff (its top note), not another tone of the same chord
    const onsets = [...new Set(list.map((w) => w.chordOn))].sort((a, b) => a - b);
    const i = onsets.indexOf(ref.chordOn);
    const on = onsets[i + dir];
    if (on === undefined) return;
    const at = list.filter((w) => w.chordOn === on);
    next = at[at.length - 1];
  }
  if (next) useStudio.setState({ selection: new Set(next.ids) });
}

/** Runs a key action; returns whether it was handled. */
export function performSheetAction(a: SheetAction): boolean {
  const st = useStudio.getState();
  const ui = useSheetUi.getState();
  switch (a.type) {
    case 'pitch': {
      // a selected dynamic: louder / softer
      const d = !st.selection.size ? selectedMark('dyn') : null;
      if (d) {
        const lv: DynamicValue[] = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
        const i = lv.indexOf(d.value);
        const next = lv[Math.max(0, Math.min(lv.length - 1, (i < 0 ? 3 : i) + a.dir))];
        if (next !== d.value) sheetMark.dyn(next);
        return true;
      }
      sheetEdit.pitch(a.kind, a.dir);
      return true;
    }
    case 'move':
      if (st.markSel && !st.selection.size) moveSelectedMark(a.dir, a.beat);
      else sheetEdit.move(a.dir, a.beat);
      return true;
    case 'selectNext':
      selectNeighbor(a.dir);
      return true;
    case 'seek': {
      const p = getPlayer();
      p.seek(Math.max(0, p.getTime() + a.dir * (a.small ? 1 : 5)));
      return true;
    }
    case 'length':
      if (st.selection.size) sheetEdit.length({ step: a.step });
      else ui.set({ addLen: stepLen(ui.addLen, a.step) });
      return true;
    case 'dot':
      if (st.selection.size) sheetEdit.length({ dot: true });
      return true;
    case 'triplet':
      if (st.selection.size) sheetEdit.length({ triplet: true });
      else ui.set({ triplet: !ui.triplet });
      return true;
    case 'addMode':
      ui.set({ addMode: !ui.addMode });
      return true;
    case 'escape':
      if (ui.help) ui.set({ help: false });
      else if (ui.picker || ui.panel) ui.set({ picker: null, panel: null });
      else if (ui.menu) ui.set({ menu: null });
      else if (ui.addMode) ui.set({ addMode: false });
      else st.clearSelection();
      return true;
    case 'delete':
      if (st.markSel && !st.selection.size) sheetMark.remove();
      else sheetEdit.remove();
      return true;
    case 'hand':
      sheetEdit.hand(a.hand);
      return true;
    case 'tie':
      sheetEdit.tie();
      return true;
    case 'undo':
      st.undo();
      return true;
    case 'redo':
      st.redo();
      return true;
    case 'selectAll': {
      const arr = currentArrangement(st);
      if (arr) st.select(arr.notes.map((n) => n.id));
      return true;
    }
    case 'quantize':
      toast.info('Notes on the sheet already follow its grid.');
      return true;
    case 'finger':
      sheetMark.finger(a.finger);
      return true;
    case 'art':
      sheetMark.art(a.art);
      return true;
    case 'slur':
      sheetMark.slur();
      return true;
    case 'wedge':
      sheetMark.wedge(a.dir);
      return true;
    case 'pedal':
      sheetMark.pedal();
      return true;
    case 'help':
      ui.set({ help: !ui.help, menu: null });
      return true;
    case 'picker': {
      const bar = a.picker === 'key' || a.picker === 'time' || a.picker === 'tempo';
      ui.set({ panel: bar ? 'bar' : 'marks', tab: bar ? 'bar' : 'marks', picker: a.picker, menu: null, viaKey: true });
      return true;
    }
  }
}

const ADD_LENS = [3, 6, 12, 24, 48];
function stepLen(len: number, step: 1 | -1): number {
  const ctx = sheetCtx();
  const list = ctx?.level === 'easy' ? ADD_LENS.filter((l) => l >= 6) : ADD_LENS;
  if (step > 0) return list.find((l) => l > len) ?? len;
  return [...list].reverse().find((l) => l < len) ?? len;
}
