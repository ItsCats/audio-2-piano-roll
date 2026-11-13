/**
 * The sheet music's edit bar: a toolbar row under the Studio header on a computer, a dock at the
 * bottom of the screen on phones and tablets (and in full screen). One component, two layouts.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Link2, Pencil, Plus, Redo2, Trash2, Undo2, Hand as HandIcon, Minus } from 'lucide-react';
import { currentArrangement, useStudio } from '../../../state/studioStore';
import { useCompactSheetUi, useSheetUi } from '../../../state/sheetUi';
import { buildSheet } from '../../../lib/sheet';
import { lengthName, lengthsAt, spanOf, tieState, type SheetCtx } from '../../../lib/sheet/edit';
import { pitchLabel } from '../../../lib/sheet/pitch';
import { sheetEdit } from './sheetActions';
import { cn } from '../../ui';

export { useCompactSheetUi };

const LEN_CHIPS: [number, string, string][] = [
  [3, '16th', '16th note'],
  [6, '8th', '8th note'],
  [12, 'Quarter', 'Quarter note'],
  [24, 'Half', 'Half note'],
  [48, 'Whole', 'Whole note'],
];

function Tool({
  label,
  title,
  onClick,
  disabled,
  active,
  dock,
  children,
  testId,
  wide,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  dock: boolean;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? `${title ?? label} — select a note first` : (title ?? label)}
      aria-pressed={active}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      // keep the keyboard focus on the sheet: shortcuts keep working after a click
      onPointerDown={(e) => e.pointerType === 'mouse' && e.preventDefault()}
      className={cn(
        'focus-ring inline-flex shrink-0 items-center justify-center gap-1 font-medium transition-colors disabled:pointer-events-none disabled:opacity-35',
        dock ? 'h-12 min-w-12 rounded-xl px-2 text-[13px]' : 'h-9 min-w-9 rounded-lg px-1.5 text-[12.5px]',
        wide && (dock ? 'px-3' : 'px-2'),
        active ? 'bg-accent-500/25 text-accent-200 ring-1 ring-accent-500/50' : 'text-ink-100 hover:bg-ink-700/70',
      )}
    >
      {children}
    </button>
  );
}

const Sep = ({ dock }: { dock: boolean }) => <span aria-hidden className={cn('shrink-0 bg-ink-700', dock ? 'mx-0.5 h-8 w-px' : 'mx-1 h-5 w-px')} />;

export function SheetEditBar({ layout, fixed = false }: { layout: 'row' | 'dock'; fixed?: boolean }) {
  const dock = layout === 'dock';
  const song = useStudio((s) => s.song)!;
  const difficulty = useStudio((s) => s.difficulty);
  const arr = useStudio(currentArrangement)!;
  const selection = useStudio((s) => s.selection);
  const past = useStudio((s) => s.past.length);
  const future = useStudio((s) => s.future.length);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const ui = useSheetUi();
  const [collapsed, setCollapsed] = useState(false);
  const ctx: SheetCtx | null = useMemo(() => (arr.notes.length || song.sheet ? { song, level: difficulty, score: buildSheet(song, difficulty) } : null), [song, difficulty, arr]);
  const selected = useMemo(() => arr.notes.filter((n) => selection.has(n.id)), [arr, selection]);
  const has = selected.length > 0;
  const single = selected.length === 1 ? selected[0] : null;
  const span = ctx && single ? spanOf(ctx, single) : null;
  const curLen = span ? span.off - span.on : null;
  const lens = ctx ? lengthsAt(ctx.score, span?.on ?? 0) : [];
  const easy = difficulty === 'easy';
  const tie = ctx && has ? tieState(ctx, selection) : null;
  const t = ctx?.score.time;
  const bar = span && t ? t.measureOf(span.on) + (t.pickup ? 0 : 1) : null;
  const touch = dock;
  const status = single
    ? `${pitchLabel(single.midi, ctx?.score.fifths ?? 0, ctx?.score.minorTonic)} · ${curLen ? lengthName(curLen) : ''} · bar ${bar} · ${single.hand === 'L' ? 'left' : 'right'} hand`
    : selected.length
      ? `${selected.length} notes`
      : ui.addMode
        ? `${touch ? 'Tap' : 'Click'} the staff to place a note`
        : `${touch ? 'Tap' : 'Click'} a note to edit it`;
  const chipLen = has ? curLen : ui.addLen;
  const setLen = (len: number) => (has ? sheetEdit.length({ len }) : ui.set({ addLen: len }));
  const dotted = chipLen !== null && [9, 18, 36, 72].includes(chipLen);
  const triplet = chipLen !== null && [4, 8].includes(chipLen);
  const baseLen = chipLen === null ? null : dotted ? chipLen / 1.5 : triplet ? chipLen * 1.5 : chipLen;
  const label = (s: string) => <span className={cn(dock ? 'text-[12.5px]' : 'text-[12px]')}>{s}</span>;
  const iconSize = dock ? 20 : 16;

  const tools = (
    <>
      <Tool dock={dock} label="Up a step" title="Up one step in the key (↑)" disabled={!has} onClick={() => sheetEdit.pitch('step', 1)} testId="sheet-up">
        <ArrowUp size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Down a step" title="Down one step in the key (↓)" disabled={!has} onClick={() => sheetEdit.pitch('step', -1)} testId="sheet-down">
        <ArrowDown size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Octave up" title="Up an octave (Shift+↑)" disabled={!has} onClick={() => sheetEdit.pitch('octave', 1)}>
        <ChevronsUp size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Octave down" title="Down an octave (Shift+↓)" disabled={!has} onClick={() => sheetEdit.pitch('octave', -1)}>
        <ChevronsDown size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Sharp" title="Up a semitone (Alt+↑)" disabled={!has} onClick={() => sheetEdit.pitch('semi', 1)}>
        <span className="text-[17px] leading-none">♯</span>
      </Tool>
      <Tool dock={dock} label="Flat" title="Down a semitone (Alt+↓)" disabled={!has} onClick={() => sheetEdit.pitch('semi', -1)}>
        <span className="text-[17px] leading-none">♭</span>
      </Tool>
      <Sep dock={dock} />
      <Tool dock={dock} label="Earlier" title="Earlier by a grid step (←, Shift: a beat)" disabled={!has} onClick={() => sheetEdit.move(-1)} testId="sheet-earlier">
        <ChevronLeft size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Later" title="Later by a grid step (→, Shift: a beat)" disabled={!has} onClick={() => sheetEdit.move(1)} testId="sheet-later">
        <ChevronRight size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Shorter" title="Shorter ([)" disabled={!has} onClick={() => sheetEdit.length({ step: -1 })} testId="sheet-shorter">
        <Minus size={iconSize - 2} />
        {label('Len')}
      </Tool>
      <Tool dock={dock} label="Longer" title="Longer (])" disabled={!has} onClick={() => sheetEdit.length({ step: 1 })} testId="sheet-longer">
        <Plus size={iconSize - 2} />
        {label('Len')}
      </Tool>
      <Sep dock={dock} />
      {LEN_CHIPS.filter(([l]) => !easy || l >= 6).map(([l, short, long]) => (
        <Tool key={l} dock={dock} wide label={long} title={has ? `Make it a ${long.toLowerCase()}` : `Add ${long.toLowerCase()}s`} active={baseLen === l} onClick={() => setLen(l)} disabled={has && !lens.includes(l)}>
          {label(short)}
        </Tool>
      ))}
      <Tool dock={dock} label="Dot" title="Dot on/off (.)" active={dotted} disabled={!has} onClick={() => sheetEdit.length({ dot: true })}>
        {label('Dot')}
      </Tool>
      {!easy && (
        <Tool dock={dock} label="Triplet" title="Triplet on/off (Alt+3)" active={triplet || (!has && ui.triplet)} onClick={() => (has ? sheetEdit.length({ triplet: true }) : ui.set({ triplet: !ui.triplet }))}>
          {label('3')}
        </Tool>
      )}
      <Sep dock={dock} />
      <Tool dock={dock} label="Left hand" title="Left hand: bass staff (L)" disabled={!has} active={has && selected.every((n) => n.hand === 'L')} onClick={() => sheetEdit.hand('L')}>
        <span className="font-semibold text-lh">L</span>
      </Tool>
      <Tool dock={dock} label="Right hand" title="Right hand: treble staff (R)" disabled={!has} active={has && selected.every((n) => n.hand === 'R')} onClick={() => sheetEdit.hand('R')}>
        <span className="font-semibold text-rh">R</span>
      </Tool>
      <Tool dock={dock} label="Swap hands" title="Swap hands (H)" disabled={!has} onClick={() => sheetEdit.hand('toggle')} testId="sheet-hand">
        <HandIcon size={iconSize} />
      </Tool>
      <Tool dock={dock} label={tie === 'untie' ? 'Untie' : 'Tie'} title={tie === 'untie' ? 'Untie (T)' : 'Tie two notes (T)'} disabled={!tie} active={tie === 'untie'} onClick={sheetEdit.tie}>
        <Link2 size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Delete" title="Delete (Del)" disabled={!has} onClick={sheetEdit.remove} testId="sheet-delete">
        <Trash2 size={iconSize} />
      </Tool>
      <Sep dock={dock} />
      <Tool dock={dock} wide label="Add notes" title={`Add notes: ${touch ? 'tap' : 'click'} the staff (N)`} active={ui.addMode} onClick={() => ui.set({ addMode: !ui.addMode })} testId="sheet-add">
        <Pencil size={iconSize - 2} />
        {label('Add')}
      </Tool>
      <Tool dock={dock} wide label="Add bar" title="Add an empty bar at the end" onClick={sheetEdit.addBar} testId="sheet-add-bar">
        <Plus size={iconSize - 2} />
        {label('Bar')}
      </Tool>
    </>
  );

  const chips = ui.chips.length > 1 && (
    <span className="flex items-center gap-1">
      {ui.chips.map((c) => (
        <button
          key={c.ids.join(',')}
          type="button"
          onClick={() => useStudio.setState({ selection: new Set(c.ids) })}
          className={cn(
            'focus-ring rounded-md px-2 font-mono text-[11.5px]',
            dock ? 'h-9' : 'h-7',
            c.ids.some((id) => selection.has(id)) ? 'bg-accent-500/25 text-accent-200' : 'bg-ink-800 text-ink-200 hover:bg-ink-700',
          )}
        >
          {c.label}
        </button>
      ))}
    </span>
  );

  if (!dock)
    return (
      <div className="flex flex-wrap items-center gap-0.5 border-b border-ink-800 bg-ink-900/95 px-3 py-1" data-testid="sheet-edit-bar" role="toolbar" aria-label="Edit the sheet music">
        <span className="mr-1 rounded-md bg-accent-500/15 px-2 py-1 text-[11.5px] font-semibold text-accent-300 capitalize">Editing: {difficulty}</span>
        <Tool dock={false} label="Undo" title="Undo (Ctrl+Z)" disabled={!past} onClick={undo} testId="sheet-undo">
          <Undo2 size={16} />
        </Tool>
        <Tool dock={false} label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future} onClick={redo} testId="sheet-redo">
          <Redo2 size={16} />
        </Tool>
        <Sep dock={false} />
        {tools}
        <span className="ml-auto flex min-w-0 items-center gap-2 pl-2 text-[11.5px] text-ink-300" aria-live="polite" data-testid="sheet-status">
          {chips}
          <span className="truncate">{status}</span>
        </span>
      </div>
    );

  return (
    <div
      className={cn('border-t border-ink-700 bg-ink-900/97', fixed && 'fixed inset-x-0 bottom-0 z-40 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur')}
      style={fixed ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
      data-testid="sheet-edit-dock"
      role="toolbar"
      aria-label="Edit the sheet music"
    >
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <span className="shrink-0 rounded-md bg-accent-500/15 px-2 py-1 text-[11px] font-semibold text-accent-300 capitalize">{difficulty}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-200" aria-live="polite" data-testid="sheet-status">
          {status}
        </span>
        <Tool dock label="Undo" disabled={!past} onClick={undo} testId="sheet-undo">
          <Undo2 size={20} />
        </Tool>
        <Tool dock label="Redo" disabled={!future} onClick={redo} testId="sheet-redo">
          <Redo2 size={20} />
        </Tool>
        <Tool dock label={collapsed ? 'Show tools' : 'Hide tools'} onClick={() => setCollapsed((c) => !c)}>
          <ChevronsDown size={20} className={cn('transition-transform', collapsed && 'rotate-180')} />
        </Tool>
      </div>
      {chips && <div className="flex gap-1 overflow-x-auto px-2 pt-1">{chips}</div>}
      {!collapsed && <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain px-2 py-1.5">{tools}</div>}
    </div>
  );
}

/** Height (px) the dock covers at the bottom of the sheet (padding so the last line can scroll above it). */
export const DOCK_PAD = 150;
