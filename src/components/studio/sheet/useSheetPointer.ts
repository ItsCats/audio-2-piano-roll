/**
 * Pointer input on the sheet in Edit mode. Mouse and pen: click selects (Shift / Ctrl / Cmd adds),
 * a drag on empty paper draws a box, dragging a selected note moves it (vertical: steps in the key,
 * Alt: semitones; sideways: grid steps) and commits on release as one undo step, a double-click on
 * a staff adds a note, right-click opens the menu. Touch: a one-finger drag always scrolls; only a
 * clean tap (under 8 px, under 450 ms) selects or, in Add mode, places a note.
 */
import { useRef } from 'react';
import { create } from 'zustand';
import type { SheetRenderer, SheetSlot, NoteHit } from '../../../lib/sheet/render';
import { addOp, lengthName, shiftOp } from '../../../lib/sheet/edit';
import { pitchLabel, stepInKey } from '../../../lib/sheet/pitch';
import { audition, runSheetEdit } from '../../../state/sheetEdit';
import { useSheetUi } from '../../../state/sheetUi';
import { useStudio } from '../../../state/studioStore';
import { getPlayer } from '../../../state/playback';

export interface SheetGhost {
  x: number;
  y: number;
  label: string;
  /** For ledger lines: the staff's top line, the gap, and the shown diatonic step from the top line. */
  staffTop: number;
  gap: number;
  /** Half-gap steps from the top line (positive = higher). */
  steps: number;
}

interface OverlayState {
  ghost: SheetGhost | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  set: (p: Partial<Omit<OverlayState, 'set'>>) => void;
}

export const useSheetOverlay = create<OverlayState>((set) => ({ ghost: null, marquee: null, set: (p) => set(p) }));

const slotGhost = (s: SheetSlot, len: number): SheetGhost => ({
  x: s.x,
  y: s.y,
  label: `${pitchLabel(s.midi)} · ${lengthName(len)}`,
  staffTop: s.staffTop,
  gap: s.gap,
  steps: Math.round((s.staffTop - s.y) / (s.gap / 2)),
});

let dragSeq = 0;

interface Down {
  x: number;
  y: number;
  cx: number;
  cy: number;
  t: number;
  type: string;
  hit: NoteHit | null;
  moved: boolean;
  mode: 'note' | 'marquee' | 'tap' | 'add';
  additive: boolean;
}

export function useSheetPointer(opts: {
  renderer: () => SheetRenderer | null;
  layer: () => HTMLElement | null;
  enabled: boolean;
  onSeek: (t: number) => void;
}) {
  const down = useRef<Down | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number; i: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = opts.layer()?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : null;
  };
  const addAt = (s: SheetSlot) => {
    const len = useSheetUi.getState().addLen;
    if (runSheetEdit((c) => addOp(c, { pos: s.pos, midi: s.midi, staff: s.staff, len }))) audition([s.midi]);
  };
  /** Chips for notes close together under the pointer (repeated taps cycle through them). */
  const pick = (hits: NoteHit[], p: { x: number; y: number }, touch: boolean): NoteHit | null => {
    if (!hits.length) {
      useSheetUi.getState().set({ chips: [] });
      return null;
    }
    const d0 = Math.hypot(p.x - hits[0].cx, (p.y - hits[0].cy) * 1.5);
    const close = hits.filter((h) => Math.hypot(p.x - h.cx, (p.y - h.cy) * 1.5) - d0 <= 6);
    const uniq = close.filter((h, i) => close.findIndex((o) => o.key === h.key) === i);
    useSheetUi.getState().set({ chips: uniq.length > 1 ? uniq.map((h) => ({ ids: h.ids, label: pitchLabel(h.midi) })) : [] });
    if (touch && uniq.length > 1) {
      const lt = lastTap.current;
      const again = lt && Math.hypot(lt.x - p.x, lt.y - p.y) < 10 && performance.now() - lt.at < 1500;
      const i = again ? (lt!.i + 1) % uniq.length : 0;
      lastTap.current = { x: p.x, y: p.y, at: performance.now(), i };
      return uniq[i];
    }
    return uniq[0];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!opts.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const r = opts.renderer();
    const p = local(e);
    if (!r || !p) return;
    const touch = e.pointerType === 'touch';
    const ui = useSheetUi.getState();
    if (ui.menu) ui.set({ menu: null });
    const base: Down = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, t: performance.now(), type: e.pointerType, hit: null, moved: false, mode: 'tap', additive: e.shiftKey || e.ctrlKey || e.metaKey };
    if (ui.addMode) {
      down.current = { ...base, mode: 'add' };
      const s = r.slotAt(p.x, p.y);
      useSheetOverlay.getState().set({ ghost: s ? slotGhost(s, ui.addLen) : null });
      return;
    }
    const hits = r.notesAt(p.x, p.y, e.pointerType);
    if (touch) {
      // touch never drags notes: decide on release
      down.current = { ...base, hit: hits[0] ?? null };
      return;
    }
    const hit = pick(hits, p, false);
    if (hit) {
      const st = useStudio.getState();
      if (base.additive) st.select(hit.ids, true);
      else if (!hit.ids.every((id) => st.selection.has(id))) st.select(hit.ids);
      down.current = { ...base, hit, mode: 'note' };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
    } else {
      down.current = { ...base, mode: 'marquee' };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  /** The drag target of a selected note: diatonic steps (or semitones) and divisions. */
  const dragTarget = (d: Down, p: { x: number; y: number }, alt: boolean) => {
    const r = opts.renderer();
    const s = r?.drawnScore;
    const h = d.hit!;
    const box = r?.box(h.measure);
    const gap = box?.gap ?? 10;
    const steps = Math.round((d.y - p.y) / (gap / 2));
    let delta = 0;
    const slot = r?.slotAt(p.x, h.cy);
    if (slot && s) delta = slot.pos - h.pos;
    let midi = h.midi;
    if (alt) midi += steps;
    else for (let i = 0; i < Math.abs(steps); i++) midi = stepInKey(midi, steps > 0 ? 1 : -1, s?.fifths ?? 0, s?.minorTonic);
    return { steps, delta, midi, gap, x: slot?.x ?? h.cx, y: h.cy - steps * (gap / 2) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!opts.enabled) return;
    const p = local(e);
    const r = opts.renderer();
    if (!p || !r) return;
    const d = down.current;
    const ui = useSheetUi.getState();
    if (!d) {
      // Add mode hover: the note that a click would place
      if (ui.addMode && e.pointerType !== 'touch') {
        const s = r.slotAt(p.x, p.y);
        useSheetOverlay.getState().set({ ghost: s ? slotGhost(s, ui.addLen) : null });
      }
      return;
    }
    const dist = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
    if (d.type === 'touch') {
      if (dist >= 8) d.moved = true;
      return;
    }
    if (!d.moved && dist < 4) return;
    d.moved = true;
    if (d.mode === 'note' && d.hit) {
      const tg = dragTarget(d, p, e.altKey);
      const s = r.drawnScore;
      useSheetOverlay.getState().set({
        ghost: { x: tg.x, y: tg.y, label: `${pitchLabel(tg.midi, s?.fifths ?? 0, s?.minorTonic)}`, staffTop: tg.y, gap: tg.gap, steps: 0 },
      });
    } else if (d.mode === 'marquee') {
      useSheetOverlay.getState().set({ marquee: { x0: d.x, y0: d.y, x1: p.x, y1: p.y } });
    } else if (d.mode === 'add') {
      const s = r.slotAt(p.x, p.y);
      useSheetOverlay.getState().set({ ghost: s ? slotGhost(s, ui.addLen) : null });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!opts.enabled || !d) return;
    const p = local(e);
    const r = opts.renderer();
    const ov = useSheetOverlay.getState();
    if (!p || !r) return;
    const st = useStudio.getState();
    if (d.type === 'touch') {
      ov.set({ ghost: null });
      const tap = !d.moved && performance.now() - d.t < 450 && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 8;
      if (!tap) return;
      if (d.mode === 'add') {
        const s = r.slotAt(p.x, p.y);
        if (s) addAt(s);
        return;
      }
      const hit = pick(r.notesAt(p.x, p.y, 'touch'), p, true);
      if (hit) st.select(hit.ids);
      else {
        st.clearSelection();
        const t = r.timeAtPoint(p.x, p.y);
        if (t !== null) opts.onSeek(t);
      }
      return;
    }
    if (d.mode === 'add') {
      const s = r.slotAt(p.x, p.y);
      ov.set({ ghost: null });
      if (s) addAt(s);
      return;
    }
    if (d.mode === 'note') {
      ov.set({ ghost: null });
      if (!d.moved) {
        // a plain click on a note of a larger selection selects just it
        if (!d.additive && d.hit && st.selection.size > d.hit.ids.length) st.select(d.hit.ids);
        return;
      }
      const tg = dragTarget(d, p, e.altKey);
      const by = e.altKey ? { semis: tg.steps, delta: tg.delta } : { steps: tg.steps, delta: tg.delta };
      if (runSheetEdit((c) => shiftOp(c, st.selection, by), { coalesceKey: `sheet-drag-${++dragSeq}` }) && tg.steps) audition([tg.midi]);
      return;
    }
    if (d.mode === 'marquee') {
      const m = ov.marquee;
      ov.set({ marquee: null });
      if (d.moved && m) {
        st.select(r.marquee(m.x0, m.y0, m.x1, m.y1), d.additive);
        return;
      }
      // a click on empty paper: clear the selection and jump there
      if (!d.additive) st.clearSelection();
      useSheetUi.getState().set({ chips: [] });
      const t = r.timeAtPoint(p.x, p.y);
      if (t !== null) opts.onSeek(t);
    }
  };

  const onPointerLeave = () => {
    if (!down.current) useSheetOverlay.getState().set({ ghost: null });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!opts.enabled || useSheetUi.getState().addMode) return;
    const p = local(e);
    const r = opts.renderer();
    if (!p || !r) return;
    const hits = r.notesAt(p.x, p.y, 'mouse');
    if (hits.length) {
      // the whole chord
      const h = hits[0];
      const ids = r.noteHits().filter((o) => o.measure === h.measure && o.pos === h.pos && o.staff === h.staff).flatMap((o) => o.ids);
      useStudio.getState().select(ids);
      return;
    }
    const s = r.slotAt(p.x, p.y);
    if (s) addAt(s);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (!opts.enabled) return;
    e.preventDefault();
    const p = local(e);
    const r = opts.renderer();
    if (p && r) {
      const h = r.notesAt(p.x, p.y, 'mouse')[0];
      const st = useStudio.getState();
      if (h && !h.ids.every((id) => st.selection.has(id))) st.select(h.ids);
    }
    useSheetUi.getState().set({ menu: { x: e.clientX, y: e.clientY } });
  };

  const onPointerCancel = () => {
    down.current = null;
    useSheetOverlay.getState().set({ ghost: null, marquee: null });
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onDoubleClick, onContextMenu, onPointerCancel, seekPlayer: (t: number) => getPlayer().seek(Math.max(0, t)) };
}
