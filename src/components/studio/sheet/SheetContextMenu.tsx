/** Right-click menu on the sheet in Edit mode: the selection's actions with their shortcuts. */
import { useEffect, useRef } from 'react';
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
    if (!menu) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && set({ menu: null });
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, set]);
  if (!menu) return null;
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
    <div ref={ref} role="menu" className="panel fixed z-50 w-52 p-1.5 shadow-2xl" style={{ left: x, top: y }} data-testid="sheet-menu">
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
          className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink-100 hover:bg-ink-700 disabled:opacity-40"
        >
          {label}
          <span className="font-mono text-[11px] text-ink-400">{key}</span>
        </button>
      ))}
    </div>
  );
}
