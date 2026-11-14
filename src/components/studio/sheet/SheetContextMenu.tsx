/**
 * Right-click menu on the sheet in Edit mode: the selection's actions with their shortcuts. A long
 * press on a touch screen opens the same actions as a sheet at the bottom, with big buttons.
 */
import { useEffect, useRef } from 'react';
import { currentArrangement } from '../../../state/studioStore';
import { cn } from '../../ui';
import { useSheetUi } from '../../../state/sheetUi';
import { useStudio } from '../../../state/studioStore';
import { sheetEdit, sheetMark } from './sheetActions';

export function SheetContextMenu() {
  const menu = useSheetUi((s) => s.menu);
  const set = useSheetUi((s) => s.set);
  const has = useStudio((s) => s.selection.size > 0);
  const markSel = useStudio((s) => s.markSel);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // the touch action sheet closes from its own backdrop
    if (!menu || menu.touch) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && set({ menu: null });
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, set]);
  useEffect(() => {
    // the menu takes the focus (its first action) so the arrow keys move through it, not the note
    if (!menu || menu.touch) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (prev && document.contains(prev)) prev.focus?.({ preventScroll: true });
    };
  }, [menu]);
  if (!menu) return null;
  if (menu.touch) return <TouchActions />;
  const onKey = (e: React.KeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const go = (j: number) => btns[(j + btns.length) % btns.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? btns.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(btns.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') set({ menu: null });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const items: [string, string, () => unknown, boolean][] = [
    ['Up a step', '↑', () => sheetEdit.pitch('step', 1), has],
    ['Down a step', '↓', () => sheetEdit.pitch('step', -1), has],
    ['Octave up', 'Shift+↑', () => sheetEdit.pitch('octave', 1), has],
    ['Octave down', 'Shift+↓', () => sheetEdit.pitch('octave', -1), has],
    ['Longer', ']', () => sheetEdit.length({ step: 1 }), has],
    ['Shorter', '[', () => sheetEdit.length({ step: -1 }), has],
    ['Swap hands', 'H', () => sheetEdit.hand('toggle'), has],
    ['Tie / untie', 'T', sheetEdit.tie, has],
    ['Delete', 'Del', sheetEdit.remove, has],
    ['Staccato', 'S', () => sheetMark.art('staccato'), has],
    ['Accent', 'A', () => sheetMark.art('accent'), has],
    ['Slur', 'Shift+S', sheetMark.slur, has],
    ['Pedal', 'P', sheetMark.pedal, true],
    ['Dynamics…', 'D', () => set({ panel: 'marks', picker: 'dyn', viaKey: true }), true],
    ['Add notes', 'N', () => set({ addMode: true }), true],
  ];
  if (markSel && !has) items.unshift(['Delete marking', 'Del', sheetMark.remove, true]);
  const x = Math.min(menu.x, window.innerWidth - 220);
  const y = Math.min(menu.y, window.innerHeight - items.length * 34 - 16);
  return (
    <div ref={ref} role="menu" aria-label="Note actions" onKeyDown={onKey} className="panel fixed z-50 w-52 p-1.5 shadow-2xl" style={{ left: x, top: y }} data-testid="sheet-menu">
      {items.map(([label, key, fn, ok]) => (
        <button
          key={label}
          role="menuitem"
          type="button"
          disabled={!ok}
          onClick={() => {
            set({ menu: null });
            fn();
          }}
          className="focus-ring flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-100 hover:bg-ink-700 focus:bg-ink-700 disabled:opacity-40"
        >
          {label}
          <span className="font-mono text-[11px] text-ink-400">{key}</span>
        </button>
      ))}
    </div>
  );
}

/** The action sheet of a long press on a note (touch). */
function TouchActions() {
  const menu = useSheetUi((s) => s.menu)!;
  const set = useSheetUi((s) => s.set);
  const selection = useStudio((s) => s.selection);
  const arr = useStudio(currentArrangement);
  const sel = arr?.notes.filter((n) => selection.has(n.id)) ?? [];
  const finger = sel.length && sel.every((n) => n.finger === sel[0].finger) ? sel[0].finger : undefined;
  const run = (fn: () => unknown, close = true) => () => {
    if (close) set({ menu: null });
    fn();
  };
  const big = 'focus-ring flex h-12 items-center justify-center rounded-xl bg-ink-800 px-3 text-[14px] font-medium text-ink-50 active:bg-ink-700 disabled:opacity-40';
  const selectIds = (ids?: number[]) => ids?.length && useStudio.setState({ selection: new Set(ids), markSel: null });
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && set({ menu: null })} data-testid="sheet-actions">
      <div role="menu" aria-label="Note actions" className="panel w-full rounded-b-none p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl">
        <p className="mb-2 px-1 text-[12.5px] text-ink-300">{sel.length === 1 ? '1 note selected' : `${sel.length} notes selected`}</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" role="menuitem" className={big} disabled={!menu.chordIds?.length} onClick={run(() => selectIds(menu.chordIds), false)} data-testid="sheet-act-chord">
            Select chord
          </button>
          <button type="button" role="menuitem" className={big} disabled={!menu.barIds?.length} onClick={run(() => selectIds(menu.barIds), false)} data-testid="sheet-act-bar">
            Select bar
          </button>
          <button type="button" role="menuitem" className={big} onClick={run(() => sheetEdit.hand('toggle'))}>
            Swap hands
          </button>
          <button type="button" role="menuitem" className={big} onClick={run(sheetEdit.tie)}>
            Tie / untie
          </button>
        </div>
        <p className="mt-3 mb-1.5 px-1 text-[12px] text-ink-400">Fingering</p>
        <div className="grid grid-cols-6 gap-2">
          {([1, 2, 3, 4, 5] as const).map((f) => (
            <button key={f} type="button" role="menuitem" aria-pressed={finger === f} className={cn(big, 'px-0 font-mono text-[16px]', finger === f && 'bg-accent-500/25 text-accent-200 ring-1 ring-accent-500/50')} onClick={run(() => sheetMark.finger(f))} data-testid={`sheet-act-finger-${f}`}>
              {f}
            </button>
          ))}
          <button type="button" role="menuitem" className={cn(big, 'px-0 text-[13px]')} disabled={!finger} onClick={run(() => sheetMark.finger(0))}>
            Clear
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" role="menuitem" className={cn(big, 'bg-bad/15 text-bad')} onClick={run(sheetEdit.remove)} data-testid="sheet-act-delete">
            Delete
          </button>
          <button type="button" className={big} onClick={() => set({ menu: null })}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
