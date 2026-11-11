import { Undo2, Redo2, Trash2, Magnet, ArrowUp, ArrowDown, Hand, Wand2, MousePointer2 } from 'lucide-react';
import { currentArrangement, useStudio } from '../../state/studioStore';
import { useTransport } from '../../state/transportStore';
import { IconButton, Select, cn } from '../ui';
import { noteName } from '../../lib/music/theory';

export function EditToolbar() {
  const s = useStudio();
  const tr = useTransport();
  const arr = useStudio(currentArrangement);
  const sel = s.selection;
  const selected = arr?.notes.filter((n) => sel.has(n.id)) ?? [];
  const single = selected.length === 1 ? selected[0] : null;
  const avgVel = selected.length ? selected.reduce((a, n) => a + n.vel, 0) / selected.length : 0;
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-ink-800 bg-ink-900/95 px-3 py-1.5 text-[12.5px]">
      <span className="mr-1 flex items-center gap-1.5 rounded-md bg-accent-500/15 px-2 py-1 text-[11.5px] font-semibold text-accent-300">
        <MousePointer2 size={13} /> EDIT
      </span>
      <IconButton size="sm" label="Undo (Ctrl+Z)" disabled={!s.past.length} onClick={s.undo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton size="sm" label="Redo (Ctrl+Shift+Z)" disabled={!s.future.length} onClick={s.redo}>
        <Redo2 size={16} />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-ink-700" />
      <IconButton size="sm" label="Snap to grid" active={tr.snap} onClick={() => tr.set({ snap: !tr.snap })}>
        <Magnet size={16} />
      </IconButton>
      <Select<number>
        value={tr.gridDivision}
        onChange={(gridDivision) => tr.set({ gridDivision })}
        options={[
          { value: 1, label: '1/4' },
          { value: 2, label: '1/8' },
          { value: 3, label: '1/8T' },
          { value: 4, label: '1/16' },
          { value: 8, label: '1/32' },
        ]}
      />
      <div className="mx-1 h-5 w-px bg-ink-700" />
      <IconButton size="sm" label="Transpose up (↑, Shift = octave)" disabled={!sel.size} onClick={() => s.transposeSelected(1)}>
        <ArrowUp size={16} />
      </IconButton>
      <IconButton size="sm" label="Transpose down (↓)" disabled={!sel.size} onClick={() => s.transposeSelected(-1)}>
        <ArrowDown size={16} />
      </IconButton>
      <button disabled={!sel.size} onClick={() => s.setHandSelected('L')} className="focus-ring h-8 rounded-md px-2 font-semibold text-lh hover:bg-ink-700 disabled:opacity-40" title="Assign to left hand (L)">
        L
      </button>
      <button disabled={!sel.size} onClick={() => s.setHandSelected('R')} className="focus-ring h-8 rounded-md px-2 font-semibold text-rh hover:bg-ink-700 disabled:opacity-40" title="Assign to right hand (R)">
        R
      </button>
      <IconButton size="sm" label="Swap hands (H)" disabled={!sel.size} onClick={() => s.setHandSelected('toggle')}>
        <Hand size={16} />
      </IconButton>
      <IconButton size="sm" label={`Quantize ${sel.size ? 'selection' : 'all notes'} to grid (Q)`} onClick={() => s.quantizeSelected(tr.gridDivision)}>
        <Wand2 size={16} />
      </IconButton>
      <IconButton size="sm" label="Delete (Del)" disabled={!sel.size} onClick={s.deleteSelected} className="hover:text-bad">
        <Trash2 size={16} />
      </IconButton>
      {selected.length > 0 && (
        <>
          <div className="mx-1 h-5 w-px bg-ink-700" />
          <label className="flex items-center gap-2 text-ink-300">
            Velocity
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.01}
              value={avgVel}
              className="w-24"
              style={{ ['--fill' as string]: `${avgVel * 100}%` }}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                s.edit((notes) => notes.map((n) => (sel.has(n.id) ? { ...n, vel: v } : n)), { coalesceKey: 'velocity' });
              }}
              aria-label="Velocity of selected notes"
            />
            <span className="w-8 font-mono text-[11.5px] text-ink-100">{Math.round(avgVel * 127)}</span>
          </label>
        </>
      )}
      <span className={cn('ml-auto text-[11.5px] text-ink-300', !selected.length && 'hidden sm:inline')}>
        {single
          ? `${noteName(single.midi)} · ${single.start.toFixed(2)}s · ${single.dur.toFixed(2)}s · ${single.hand === 'L' ? 'left' : 'right'}`
          : selected.length
            ? `${selected.length} notes selected`
            : 'Double-click to add · drag to move · drag ends to resize · shift-drag to select'}
      </span>
    </div>
  );
}
