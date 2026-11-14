/**
 * The sheet music's edit bar: a toolbar row under the Studio header on a computer, a dock at the
 * bottom of the screen on phones and tablets (and in full screen). One component, two layouts.
 */
import { useMemo } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Link2, Pencil, Plus, Redo2, Trash2, Undo2, Hand as HandIcon, Minus } from 'lucide-react';
import { currentArrangement, useStudio } from '../../../state/studioStore';
import { useCompactSheetUi, useSheetUi } from '../../../state/sheetUi';
import { buildSheet } from '../../../lib/sheet';
import { lengthName, lengthsAt, spanOf, tieState, type SheetCtx } from '../../../lib/sheet/edit';
import { pitchLabel } from '../../../lib/sheet/pitch';
import { keyAt } from '../../../lib/sheet/keys';
import { sheetEdit, sheetMark } from './sheetActions';
import { BarPicker, BarTools, DynPicker, MarkPanelButtons, MarksTools, TextPicker, describeMark } from './MarkPopovers';
import { moveSelectedMark } from '../../../state/sheetMarks';
import { ChevronsLeft, ChevronsRight, CircleHelp, Copy, ListPlus, Maximize } from 'lucide-react';
import { toggleStageFullscreen, useStageFullscreen } from '../../../state/fullscreenStore';
import { cn } from '../../ui';
import { Tool, Sep } from './SheetTool';

export { useCompactSheetUi };

const LEN_CHIPS: [number, string, string][] = [
  [3, '16th', '16th note'],
  [6, '8th', '8th note'],
  [12, 'Quarter', 'Quarter note'],
  [24, 'Half', 'Half note'],
  [48, 'Whole', 'Whole note'],
];

export function SheetEditBar({ layout, fixed = false }: { layout: 'row' | 'dock' | 'rail'; fixed?: boolean }) {
  const dock = layout !== 'row';
  const rail = layout === 'rail';
  const fullscreen = useStageFullscreen((s) => s.mode !== 'off');
  const song = useStudio((s) => s.song)!;
  const difficulty = useStudio((s) => s.difficulty);
  const arr = useStudio(currentArrangement)!;
  const selection = useStudio((s) => s.selection);
  const markSel = useStudio((s) => s.markSel);
  const past = useStudio((s) => s.past.length);
  const future = useStudio((s) => s.future.length);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const ui = useSheetUi();
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
  const key = ctx && span ? keyAt(ctx.score, ctx.score.time.measureOf(span.on)) : null;

  const markText = ctx && markSel && !has ? describeMark(ctx, markSel) : null;
  const markOn = !has && !!markText;
  const status = markText
    ? markText
    : single
    ? `${pitchLabel(single.midi, key?.fifths ?? 0, key?.minorTonic)} · ${curLen ? lengthName(curLen) : ''} · bar ${bar} · ${single.hand === 'L' ? 'left' : 'right'} hand${single.finger ? ` · finger ${single.finger}` : ''}`
    : selected.length
      ? `${selected.length} notes${touch && ui.selectMore ? ' · tap to add or remove' : ''}`
      : ui.addMode
        ? `${touch ? 'Tap' : 'Click'} the staff to place a note`
        : touch && ui.selectMore
          ? 'Tap notes to add them to the selection'
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
      <Tool dock={dock} label="Earlier" title="Earlier by a grid step (←, Shift: a beat)" disabled={!has && !markOn} onClick={() => (has ? sheetEdit.move(-1) : moveSelectedMark(-1))} testId="sheet-earlier">
        <ChevronLeft size={iconSize} />
      </Tool>
      <Tool dock={dock} label="Later" title="Later by a grid step (→, Shift: a beat)" disabled={!has && !markOn} onClick={() => (has ? sheetEdit.move(1) : moveSelectedMark(1))} testId="sheet-later">
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
      <Tool dock={dock} label="Delete" title="Delete (Del)" disabled={!has && !markOn} onClick={() => (has ? sheetEdit.remove() : sheetMark.remove())} testId="sheet-delete">
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

  const copyFixes = difficulty === 'hard' && (
    <Tool dock={dock} wide label="Copy fixes to Easy & Medium" title="Rebuild Easy and Medium from Hard, with its fingering and markings" onClick={sheetMark.copyFixes} testId="sheet-copy-fixes">
      <Copy size={iconSize - 2} />
      {label(dock ? 'To Easy & Medium' : 'Copy to Easy & Medium')}
    </Tool>
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
        <Sep dock={false} />
        <MarkPanelButtons />
        {copyFixes}
        <Tool dock={false} label="Help and shortcuts" title="Help and shortcuts (?)" onClick={() => ui.set({ help: true })} testId="sheet-help-open">
          <CircleHelp size={16} />
        </Tool>
        <span className="ml-auto flex min-w-0 items-center gap-2 pl-2 text-[11.5px] text-ink-300" aria-live="polite" data-testid="sheet-status">
          {chips}
          <span className="truncate">{status}</span>
        </span>
      </div>
    );

  const tabs = (
    <div className={cn('flex items-center', rail ? 'gap-2 px-2 pt-1' : 'gap-1 py-0.5 pl-2')} role="tablist" aria-label="Tools">
      {(['notes', 'marks', 'bar'] as const).map((tb) => (
        <button
          key={tb}
          type="button"
          role="tab"
          aria-selected={ui.tab === tb}
          onClick={() => ui.set({ tab: tb, picker: null })}
          className={cn('focus-ring h-11 min-w-11 flex-1 rounded-lg text-[13.5px] font-medium capitalize', ui.tab === tb ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:text-ink-100')}
          data-testid={`sheet-tab-${tb}`}
        >
          {tb === 'bar' ? 'Bar' : tb === 'marks' ? 'Marks' : 'Notes'}
        </button>
      ))}
    </div>
  );
  const picker = ui.picker && (
    <div className={cn('overflow-y-auto border-b border-ink-800', rail ? 'max-h-[55%] shrink-0' : 'max-h-[40vh]')} data-testid="sheet-dock-picker">
      {ui.picker === 'dyn' && <DynPicker dock />}
      {ui.picker === 'text' && <TextPicker dock />}
      {(ui.picker === 'key' || ui.picker === 'time' || ui.picker === 'tempo') && <BarPicker dock which={ui.picker} key={ui.picker} />}
    </div>
  );
  const selectMore = (
    <Tool dock wide label="Select more" title="Taps add notes to the selection (or take them out)" active={ui.selectMore} onClick={() => ui.set({ selectMore: !ui.selectMore })} testId="sheet-select-more">
      <ListPlus size={18} />
      {label('More')}
    </Tool>
  );
  const help = (
    <Tool dock label="Help and shortcuts" onClick={() => ui.set({ help: true })} testId="sheet-help-open">
      <CircleHelp size={20} />
    </Tool>
  );
  const toolRow = (
    <>
      {ui.tab === 'notes' ? tools : ui.tab === 'marks' ? <MarksTools dock /> : <BarTools dock />}
      {ui.tab === 'marks' && copyFixes}
    </>
  );

  if (rail) {
    // a phone held sideways: a column beside the music
    if (ui.collapsed)
      return (
        <div className="flex h-full w-[60px] flex-col items-center gap-1 border-l border-ink-700 bg-ink-900/97 py-1.5" data-testid="sheet-edit-dock" data-layout="rail" role="toolbar" aria-label="Edit the sheet music">
          <Tool dock label="Show tools" onClick={() => ui.set({ collapsed: false })} testId="sheet-dock-expand">
            <ChevronsLeft size={20} />
          </Tool>
          <Tool dock label="Undo" disabled={!past} onClick={undo} testId="sheet-undo">
            <Undo2 size={20} />
          </Tool>
          <Tool dock label="Redo" disabled={!future} onClick={redo} testId="sheet-redo">
            <Redo2 size={20} />
          </Tool>
        </div>
      );
    return (
      <div className="flex h-full w-[min(44vw,320px)] flex-col border-l border-ink-700 bg-ink-900/97" data-testid="sheet-edit-dock" data-layout="rail" role="toolbar" aria-label="Edit the sheet music">
        <div className="flex shrink-0 items-center gap-0.5 px-1.5 pt-1">
          <span className="shrink-0 rounded-md bg-accent-500/15 px-1.5 py-1 text-[11px] font-semibold text-accent-300 capitalize">{difficulty}</span>
          <span className="flex-1" />
          <Tool dock label="Undo" disabled={!past} onClick={undo} testId="sheet-undo">
            <Undo2 size={20} />
          </Tool>
          <Tool dock label="Redo" disabled={!future} onClick={redo} testId="sheet-redo">
            <Redo2 size={20} />
          </Tool>
          {help}
          <Tool dock label="Hide tools" onClick={() => ui.set({ collapsed: true })}>
            <ChevronsRight size={20} />
          </Tool>
        </div>
        <p className="line-clamp-2 shrink-0 px-2.5 pt-0.5 text-[12.5px] leading-snug text-ink-200" aria-live="polite" data-testid="sheet-status">
          {status}
        </p>
        {chips && <div className="flex shrink-0 flex-wrap gap-1 px-2 pt-1">{chips}</div>}
        {!fullscreen && (
          <button type="button" onClick={toggleStageFullscreen} className="focus-ring mx-2 mt-1 flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-ink-800 text-[12.5px] text-ink-100 hover:bg-ink-700" data-testid="sheet-rail-fullscreen">
            <Maximize size={15} /> Full screen: more room for the music
          </button>
        )}
        {tabs}
        {picker}
        <div className="flex min-h-0 flex-1 flex-wrap content-start items-center gap-1.5 overflow-y-auto overscroll-contain px-2 py-1.5 [&_.sheet-sep]:hidden">
          {ui.tab !== 'bar' && selectMore}
          {toolRow}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('border-t border-ink-700 bg-ink-900/97', fixed && 'fixed inset-x-0 bottom-0 z-40 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur')}
      style={fixed ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
      data-testid="sheet-edit-dock"
      data-layout="dock"
      role="toolbar"
      aria-label="Edit the sheet music"
    >
      {/* status line, then tabs with Undo / Redo / Help / fold on one row, then the tools */}
      <div className="flex items-center gap-1.5 px-3 pt-1">
        <span className="shrink-0 text-[11px] font-semibold text-accent-300 capitalize">{difficulty}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-200" aria-live="polite" data-testid="sheet-status">
          {status}
        </span>
      </div>
      <div className="flex items-center gap-1 pr-1">
        <div className="min-w-0 flex-1">{!ui.collapsed && tabs}</div>
        <Tool dock label="Undo" disabled={!past} onClick={undo} testId="sheet-undo">
          <Undo2 size={20} />
        </Tool>
        <Tool dock label="Redo" disabled={!future} onClick={redo} testId="sheet-redo">
          <Redo2 size={20} />
        </Tool>
        {help}
        <Tool dock label={ui.collapsed ? 'Show tools' : 'Hide tools'} onClick={() => ui.set({ collapsed: !ui.collapsed })} testId="sheet-dock-collapse">
          <ChevronsDown size={20} className={cn('transition-transform', ui.collapsed && 'rotate-180')} />
        </Tool>
      </div>
      {chips && <div className="flex gap-1 overflow-x-auto px-2 pt-1">{chips}</div>}
      {!ui.collapsed && (
        <>
          {picker}
          <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain px-2 pt-0.5 pb-1.5">
            {ui.tab !== 'bar' && selectMore}
            {toolRow}
          </div>
        </>
      )}
    </div>
  );
}

/** Height (px) the dock covers at the bottom of the sheet (padding so the last line can scroll above it). */
export const DOCK_PAD = 210;
