/**
 * The Marks and Bar tools of the sheet's edit bar: fingering, articulations, slur, dynamics,
 * hairpins, pedal and words (Marks); key, time and tempo changes (Bar). On a computer they open as
 * popovers under the edit bar; in the phone dock they are its Marks and Bar tabs, with the pickers
 * shown above the tools in large controls.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Type, Waves } from 'lucide-react';
import type { DynamicValue, SheetMark, TempoUnit } from '../../../lib/music/types';
import { buildSheet } from '../../../lib/sheet';
import { resolveMark, pedalSel } from '../../../lib/sheet/marks';
import { canRetime } from '../../../lib/sheet/retime';
import { keyAt } from '../../../lib/sheet/keys';
import { DIV } from '../../../lib/sheet/types';
import type { SheetCtx } from '../../../lib/sheet/edit';
import { setKeyAt, setMeterAt, setTempoAt, targetMeasure } from '../../../state/sheetMarks';
import { useSheetUi, type SheetPicker } from '../../../state/sheetUi';
import { currentArrangement, useStudio } from '../../../state/studioStore';
import { cn } from '../../ui';
import { DYN_ORDER, sheetMark } from './sheetActions';
import { Sep, Tool } from './SheetTool';

const MAJOR = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
/** "D major" for a key signature. */
export const keyName = (fifths: number, mode: 'major' | 'minor') => `${(mode === 'minor' ? MINOR : MAJOR)[fifths + 7] ?? '?'} ${mode}`;
const UNIT_LABEL: Record<TempoUnit, string> = { q: '♩', h: '𝅗𝅥', e: '♪', 'q.': '♩.' };
const UNIT_NAME: Record<TempoUnit, string> = { q: 'Quarter', h: 'Half', e: 'Eighth', 'q.': 'Dotted quarter' };
const DYN_SHOWN = 6;

const useCtx = (): SheetCtx | null => {
  const song = useStudio((s) => s.song);
  const level = useStudio((s) => s.difficulty);
  const arr = useStudio(currentArrangement);
  return useMemo(() => (song && arr ? { song, level, score: buildSheet(song, level) } : null), [song, level, arr]);
};

/** Closes the picker after it applied (and the popover when a shortcut opened it). */
const closePicker = () => {
  const ui = useSheetUi.getState();
  ui.set({ picker: null, ...(ui.viaKey ? { panel: null, viaKey: false } : {}) });
};

const barNo = (ctx: SheetCtx, m: number) => m + (ctx.score.time.pickup ? 0 : 1);

/** A short description of the selected marking, for the status line. */
export function describeMark(ctx: SheetCtx, sel: string | null): string | null {
  const r = resolveMark(ctx, sel);
  if (!r) return null;
  const t = ctx.score.time;
  const bar = (pos: number) => `bar ${barNo(ctx, t.measureOf(pos))}`;
  const where = (s: 0 | 1 | 2) => (s === 0 ? 'both hands' : s === 1 ? 'right hand' : 'left hand');
  if (r.type === 'pedal') return `Pedal · ${bar(Math.max(0, t.toPos(r.range.start)))}`;
  if (r.type === 'key') {
    const k = ctx.song.sheet?.keys?.find((x) => x.pos === r.pos);
    return k ? `Key: ${keyName(k.fifths, k.mode)} from ${bar(r.pos)}` : null;
  }
  if (r.type === 'time') {
    const k = ctx.song.sheet?.meters?.find((x) => x.pos === r.pos);
    return k ? `Time ${k.beatsPerBar}/${k.beatUnit} from ${bar(r.pos)}` : null;
  }
  if (r.type === 'tempo') {
    const k = ctx.song.sheet?.tempos?.find((x) => x.pos === r.pos);
    return k ? `Tempo ${UNIT_LABEL[k.unit]} = ${k.bpm}${k.text ? ` “${k.text}”` : ''} from ${bar(r.pos)}` : null;
  }
  if (r.type !== 'mark') return null;
  const m = r.mark;
  if (m.kind === 'dyn') return `${m.value} · ${bar(m.pos)} · ${where(m.staff)}`;
  if (m.kind === 'wedge') return `${m.dir === 'cresc' ? 'Crescendo' : 'Diminuendo'} · ${bar(m.pos)} · ${where(m.staff)}`;
  if (m.kind === 'text') return `“${m.text}” · ${bar(m.pos)}`;
  return 'Slur';
}

/** Closes the desktop popover on a click outside it or Esc. */
function Popover({ children, onClose, testId, label }: { children: ReactNode; onClose: () => void; testId: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = e.target as Element | null;
      // clicks on the music (selecting notes for the next marking) keep it open
      if (!ref.current?.contains(el) && !el?.closest?.('[data-sheet-panel-button], [data-testid="sheet-music"], [data-testid="sheet-edit-bar"]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label={label} className="panel absolute top-full left-0 z-50 mt-1 w-[min(560px,calc(100vw-24px))] p-2.5 shadow-2xl" data-testid={testId}>
      {children}
    </div>
  );
}

const Row = ({ label, children, dock }: { label?: string; children: ReactNode; dock: boolean }) =>
  dock ? (
    <>{children}</>
  ) : (
    <div className="flex flex-wrap items-center gap-0.5 py-0.5">
      {label && <span className="w-24 shrink-0 text-[11.5px] text-ink-300">{label}</span>}
      {children}
    </div>
  );

const txt = (s: string, dock: boolean) => <span className={dock ? 'text-[13px]' : 'text-[12.5px]'}>{s}</span>;

/** Fingering, articulations, slur, dynamics, hairpins, pedal, words. */
export function MarksTools({ dock }: { dock: boolean }) {
  const ctx = useCtx();
  const selection = useStudio((s) => s.selection);
  const markSel = useStudio((s) => s.markSel);
  const ui = useSheetUi();
  const arr = useStudio(currentArrangement);
  const sel = useMemo(() => arr?.notes.filter((n) => selection.has(n.id)) ?? [], [arr, selection]);
  const has = sel.length > 0;
  const r = ctx ? resolveMark(ctx, markSel) : null;
  const selMark = r?.type === 'mark' ? r.mark : null;
  const finger = has && sel.every((n) => n.finger === sel[0].finger) ? sel[0].finger : undefined;
  const allArt = (a: string) => has && sel.every((n) => n.art?.includes(a as never));
  const iconSize = dock ? 20 : 16;
  const openPicker = (p: SheetPicker) => ui.set({ picker: ui.picker === p ? null : p });
  return (
    <>
      <Row dock={dock} label="Fingering">
        {([1, 2, 3, 4, 5] as const).map((f) => (
          <Tool key={f} dock={dock} label={`Finger ${f}`} title={`Finger ${f} (${f}; again to clear)`} disabled={!has} active={finger === f} onClick={() => sheetMark.finger(f)} testId={`sheet-finger-${f}`}>
            <span className="font-mono text-[14px] font-semibold">{f}</span>
          </Tool>
        ))}
      </Row>
      {dock && <Sep dock />}
      <Row dock={dock} label="Articulation">
        <Tool dock={dock} label="Staccato" title="Staccato: short (S)" disabled={!has} active={allArt('staccato')} onClick={() => sheetMark.art('staccato')} testId="sheet-staccato">
          <span className="text-[18px] leading-none">•</span>
        </Tool>
        <Tool dock={dock} label="Accent" title="Accent: louder (A)" disabled={!has} active={allArt('accent')} onClick={() => sheetMark.art('accent')} testId="sheet-accent">
          <span className="font-mono text-[15px] font-bold">&gt;</span>
        </Tool>
        <Tool dock={dock} label="Tenuto" title="Tenuto: held full length (U)" disabled={!has} active={allArt('tenuto')} onClick={() => sheetMark.art('tenuto')} testId="sheet-tenuto">
          <span className="font-mono text-[15px] font-bold">–</span>
        </Tool>
        <Tool dock={dock} label="Marcato" title="Marcato: strong accent (Shift+A)" disabled={!has} active={allArt('marcato')} onClick={() => sheetMark.art('marcato')} testId="sheet-marcato">
          <span className="font-mono text-[15px] font-bold">^</span>
        </Tool>
        <Tool dock={dock} wide label="Slur" title="Slur over the selection (Shift+S). Slurs are shown on the sheet; playback uses the note lengths." disabled={sel.length < 2} onClick={sheetMark.slur} testId="sheet-slur">
          <Waves size={iconSize - 2} />
          {txt('Slur', dock)}
        </Tool>
      </Row>
      {dock && <Sep dock />}
      <Row dock={dock} label="Dynamics">
        <Tool dock={dock} wide label="Dynamics" title="Dynamics (D)" active={ui.picker === 'dyn' || selMark?.kind === 'dyn'} onClick={() => openPicker('dyn')} testId="sheet-dyn-open">
          <span className="font-serif text-[15px] font-bold italic">mf</span>
          {!dock && txt('…', dock)}
        </Tool>
        <Tool dock={dock} wide label="Crescendo" title="Crescendo over the selection (<)" active={selMark?.kind === 'wedge' && selMark.dir === 'cresc'} onClick={() => sheetMark.wedge('cresc')} testId="sheet-cresc">
          <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden className="stroke-current">
            <path d="M25 1 L1 6 L25 11" fill="none" strokeWidth="1.5" />
          </svg>
        </Tool>
        <Tool dock={dock} wide label="Diminuendo" title="Diminuendo over the selection (>)" active={selMark?.kind === 'wedge' && selMark.dir === 'dim'} onClick={() => sheetMark.wedge('dim')} testId="sheet-dim">
          <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden className="stroke-current">
            <path d="M1 1 L25 6 L1 11" fill="none" strokeWidth="1.5" />
          </svg>
        </Tool>
        <button
          type="button"
          role="switch"
          aria-checked={ui.bake}
          onClick={() => ui.set({ bake: !ui.bake })}
          title="Dynamics and hairpins change how loud the notes play. Deleting one keeps the loudness; Undo restores it."
          className={cn('focus-ring ml-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-ink-200 hover:bg-ink-700/70', dock ? 'h-12 text-[12.5px]' : 'h-9 text-[12px]')}
          data-testid="sheet-bake"
        >
          <span className={cn('relative h-4 w-7 rounded-full transition-colors', ui.bake ? 'bg-accent-500' : 'bg-ink-600')}>
            <span className={cn('absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform', ui.bake && 'translate-x-3')} />
          </span>
          Change loudness
        </button>
      </Row>
      {dock && <Sep dock />}
      <Row dock={dock} label="Pedal & words">
        <Tool dock={dock} wide label="Pedal" title="Pedal over the selection (P)" onClick={sheetMark.pedal} testId="sheet-pedal">
          <span className="font-serif text-[14px] italic">Ped.</span>
        </Tool>
        <Tool dock={dock} wide label="Show pedal marks" title="Show this level's pedal on the sheet" active={!!arr?.showPedal} onClick={() => sheetMark.showPedal(!arr?.showPedal)} testId="sheet-show-pedal">
          {txt(dock ? 'Show Ped.' : 'Show pedal', dock)}
        </Tool>
        <Tool dock={dock} wide label="Text" title="Words, such as dolce or rit. (W)" active={ui.picker === 'text' || selMark?.kind === 'text'} onClick={() => openPicker('text')} testId="sheet-text-open">
          <Type size={iconSize - 2} />
          {txt('Text', dock)}
        </Tool>
      </Row>
      {!dock && ui.picker === 'dyn' && <DynPicker dock={false} />}
      {!dock && ui.picker === 'text' && <TextPicker dock={false} />}
    </>
  );
}

/** Dynamics chips: ← / → move, Enter applies. */
export function DynPicker({ dock }: { dock: boolean }) {
  const ctx = useCtx();
  const markSel = useStudio((s) => s.markSel);
  const r = ctx ? resolveMark(ctx, markSel) : null;
  const cur = r?.type === 'mark' && r.mark.kind === 'dyn' ? r.mark.value : null;
  const [more, setMore] = useState(() => !!cur && DYN_ORDER.indexOf(cur) >= DYN_SHOWN);
  const ref = useRef<HTMLDivElement>(null);
  const list = more ? DYN_ORDER : DYN_ORDER.slice(0, DYN_SHOWN);
  useEffect(() => {
    // the active (or mf) chip takes the focus so the arrows choose right away
    const want = cur ?? 'mf';
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-dyn="${want}"]`) ?? ref.current?.querySelector<HTMLButtonElement>('[data-dyn]');
    el?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[data-dyn]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[Math.max(0, Math.min(btns.length - 1, (i < 0 ? 0 : i) + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
  };
  const apply = (v: DynamicValue) => {
    sheetMark.dyn(v);
    closePicker();
  };
  return (
    <div ref={ref} onKeyDown={onKey} className={cn('flex flex-wrap items-center gap-1', dock ? 'px-2 py-2' : 'mt-1 border-t border-ink-700 pt-2')} role="group" aria-label="Dynamics" data-testid="sheet-dyn-picker">
      {list.map((v) => (
        <button
          key={v}
          type="button"
          data-dyn={v}
          onClick={() => apply(v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              apply(v);
            }
          }}
          className={cn(
            'focus-ring rounded-lg font-serif font-bold italic',
            dock ? 'h-12 min-w-12 px-2 text-[17px]' : 'h-9 min-w-10 px-2 text-[15px]',
            cur === v ? 'bg-accent-500/25 text-accent-200 ring-1 ring-accent-500/50' : 'bg-ink-800 text-ink-50 hover:bg-ink-700 focus:bg-ink-700',
          )}
          aria-pressed={cur === v}
        >
          {v}
        </button>
      ))}
      {!more && (
        <button type="button" onClick={() => setMore(true)} className={cn('focus-ring rounded-lg px-2 text-ink-200 hover:bg-ink-700', dock ? 'h-12 text-[13px]' : 'h-9 text-[12px]')}>
          More
        </button>
      )}
    </div>
  );
}

/** Words: text, above / below, italic / bold / plain. */
export function TextPicker({ dock }: { dock: boolean }) {
  const ctx = useCtx();
  const markSel = useStudio((s) => s.markSel);
  const r = ctx ? resolveMark(ctx, markSel) : null;
  const cur = r?.type === 'mark' && r.mark.kind === 'text' ? r.mark : null;
  const [text, setText] = useState(cur?.text ?? '');
  const [above, setAbove] = useState(cur?.above ?? true);
  const [style, setStyle] = useState<'italic' | 'bold' | null>(cur ? (cur.style ?? null) : 'italic');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = () => {
    if (!text.trim()) return;
    if (sheetMark.text(text, { above, style })) closePicker();
  };
  const seg = (on: boolean) => cn('focus-ring rounded-md px-2.5', dock ? 'h-11 text-[13px]' : 'h-8 text-[12px]', on ? 'bg-ink-600 text-ink-50' : 'text-ink-300 hover:text-ink-100');
  return (
    <form
      className={cn('flex flex-wrap items-center gap-2', dock ? 'px-2 py-2' : 'mt-1 border-t border-ink-700 pt-2')}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="sheet-text-picker"
    >
      <input
        ref={input}
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && useSheetUi.getState().set({ picker: null })}
        placeholder="dolce, rit., a tempo…"
        aria-label="Words"
        className={cn('focus-ring min-w-0 flex-1 rounded-[10px] border border-ink-600 bg-ink-800 px-2.5 text-ink-50', dock ? 'h-12 text-[16px]' : 'h-9 text-[13px]')}
        data-testid="sheet-text-input"
      />
      <span className="inline-flex rounded-[9px] border border-ink-700 bg-ink-900 p-0.5" role="radiogroup" aria-label="Place">
        <button type="button" role="radio" aria-checked={above} className={seg(above)} onClick={() => setAbove(true)}>
          Above
        </button>
        <button type="button" role="radio" aria-checked={!above} className={seg(!above)} onClick={() => setAbove(false)}>
          Below
        </button>
      </span>
      <span className="inline-flex rounded-[9px] border border-ink-700 bg-ink-900 p-0.5" role="radiogroup" aria-label="Style">
        <button type="button" role="radio" aria-checked={style === 'italic'} className={cn(seg(style === 'italic'), 'italic')} onClick={() => setStyle('italic')}>
          Italic
        </button>
        <button type="button" role="radio" aria-checked={style === 'bold'} className={cn(seg(style === 'bold'), 'font-bold')} onClick={() => setStyle('bold')}>
          Bold
        </button>
        <button type="button" role="radio" aria-checked={style === null} className={seg(style === null)} onClick={() => setStyle(null)}>
          Plain
        </button>
      </span>
      <button type="submit" disabled={!text.trim()} className={cn('focus-ring rounded-lg bg-accent-500 px-3 font-medium text-white disabled:opacity-40', dock ? 'h-12 text-[14px]' : 'h-9 text-[12.5px]')} data-testid="sheet-text-apply">
        {cur ? 'Update' : 'Add'}
      </button>
    </form>
  );
}

/** Key, time and tempo changes from a bar. */
export function BarTools({ dock }: { dock: boolean }) {
  const ui = useSheetUi();
  const open = (p: SheetPicker) => ui.set({ picker: ui.picker === p ? null : p });
  return (
    <>
      <Row dock={dock}>
        <Tool dock={dock} wide label="Key signature" title="Key signature from this bar (K)" active={ui.picker === 'key'} onClick={() => open('key')} testId="sheet-key-open">
          {txt('Key…', dock)}
        </Tool>
        <Tool dock={dock} wide label="Time signature" title="Time signature from this bar (M)" active={ui.picker === 'time'} onClick={() => open('time')} testId="sheet-time-open">
          {txt('Time…', dock)}
        </Tool>
        <Tool dock={dock} wide label="Tempo" title="Tempo from this bar (Shift+T)" active={ui.picker === 'tempo'} onClick={() => open('tempo')} testId="sheet-tempo-open">
          {txt('Tempo…', dock)}
        </Tool>
      </Row>
      {!dock && ui.picker && ['key', 'time', 'tempo'].includes(ui.picker) && <BarPicker dock={false} which={ui.picker as 'key' | 'time' | 'tempo'} />}
    </>
  );
}

const field = (dock: boolean) => cn('focus-ring rounded-[10px] border border-ink-600 bg-ink-800 px-2 text-ink-50', dock ? 'h-12 text-[16px]' : 'h-9 text-[13px]');
const applyBtn = (dock: boolean) => cn('focus-ring rounded-lg bg-accent-500 px-3 font-medium text-white disabled:opacity-40', dock ? 'h-12 text-[14px]' : 'h-9 text-[12.5px]');
const TIME_PRESETS: [number, 2 | 4 | 8][] = [
  [2, 4],
  [3, 4],
  [4, 4],
  [5, 4],
  [6, 8],
  [9, 8],
  [12, 8],
  [2, 2],
];

/** The key / time / tempo picker for the target bar. */
export function BarPicker({ dock, which }: { dock: boolean; which: 'key' | 'time' | 'tempo' }) {
  const ctx = useCtx();
  const [m] = useState(() => (ctx ? targetMeasure(ctx) : 0));
  const close = closePicker;
  if (!ctx) return null;
  const from = <span className="text-[12px] text-ink-300">Applies from bar {barNo(ctx, m)}</span>;
  const wrap = (children: ReactNode, testId: string) => (
    <div className={cn('flex flex-wrap items-center gap-2', dock ? 'px-2 py-2' : 'mt-1 border-t border-ink-700 pt-2')} data-testid={testId}>
      {from}
      {children}
    </div>
  );
  if (which === 'key') return wrap(<KeyForm ctx={ctx} m={m} dock={dock} done={close} />, 'sheet-key-picker');
  if (which === 'time') return wrap(<TimeForm ctx={ctx} m={m} dock={dock} done={close} />, 'sheet-time-picker');
  return wrap(<TempoForm ctx={ctx} m={m} dock={dock} done={close} />, 'sheet-tempo-picker');
}

function KeyForm({ ctx, m, dock, done }: { ctx: SheetCtx; m: number; dock: boolean; done: () => void }) {
  const k = keyAt(ctx.score, m);
  const [v, setV] = useState(`${k.fifths}|${k.mode}`);
  const opts: { value: string; label: string }[] = [];
  for (const mode of ['major', 'minor'] as const) for (let f = -7; f <= 7; f++) opts.push({ value: `${f}|${mode}`, label: `${keyName(f, mode)} (${f === 0 ? 'no ♯/♭' : f > 0 ? `${f}♯` : `${-f}♭`})` });
  return (
    <>
      <select value={v} onChange={(e) => setV(e.target.value)} aria-label="Key" className={field(dock)} data-testid="sheet-key-select">
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={applyBtn(dock)}
        onClick={() => {
          const [f, mode] = v.split('|');
          setKeyAt(m, Number(f), mode as 'major' | 'minor');
          done();
        }}
        data-testid="sheet-key-apply"
      >
        Apply
      </button>
    </>
  );
}

function TimeForm({ ctx, m, dock, done }: { ctx: SheetCtx; m: number; dock: boolean; done: () => void }) {
  const mt = ctx.score.time.meterAt(m);
  const [beats, setBeats] = useState(mt.beatsPerBar);
  const [unit, setUnit] = useState<2 | 4 | 8>(mt.beatUnit);
  return (
    <>
      <span className="flex flex-wrap gap-1">
        {TIME_PRESETS.map(([b, u]) => (
          <button
            key={`${b}/${u}`}
            type="button"
            onClick={() => {
              setBeats(b);
              setUnit(u);
            }}
            className={cn('focus-ring rounded-lg px-2 font-mono', dock ? 'h-12 min-w-12 text-[15px]' : 'h-9 min-w-10 text-[13px]', beats === b && unit === u ? 'bg-accent-500/25 text-accent-200 ring-1 ring-accent-500/50' : 'bg-ink-800 text-ink-50 hover:bg-ink-700')}
            data-testid={`sheet-time-${b}-${u}`}
          >
            {b}/{u}
          </button>
        ))}
      </span>
      <input type="number" min={1} max={16} value={beats} onChange={(e) => setBeats(Math.max(1, Math.min(16, Math.round(Number(e.target.value) || 1))))} aria-label="Beats per bar" className={cn(field(dock), 'w-16')} />
      <span className="text-ink-300">/</span>
      <select value={unit} onChange={(e) => setUnit(Number(e.target.value) as 2 | 4 | 8)} aria-label="Beat unit" className={field(dock)}>
        <option value={2}>2</option>
        <option value={4}>4</option>
        <option value={8}>8</option>
      </select>
      <button
        type="button"
        className={applyBtn(dock)}
        title="The notes stay where they are; the bars are regrouped from here."
        onClick={() => {
          setMeterAt(m, beats, unit);
          done();
        }}
        data-testid="sheet-time-apply"
      >
        Apply
      </button>
    </>
  );
}

function TempoForm({ ctx, m, dock, done }: { ctx: SheetCtx; m: number; dock: boolean; done: () => void }) {
  const pos = ctx.score.time.measureStart(m);
  const existing = ctx.song.sheet?.tempos?.find((x) => x.pos === pos);
  const secs = ctx.score.measureStartTimes[m + 1] - ctx.score.measureStartTimes[m];
  const playedQpm = secs > 0 ? Math.round(((ctx.score.time.measureLenAt(m) / DIV) * 60) / secs) : 120;
  const [bpm, setBpm] = useState(existing?.bpm ?? playedQpm);
  const [unit, setUnit] = useState<TempoUnit>(existing?.unit ?? 'q');
  const [text, setText] = useState(existing?.text ?? '');
  const can = canRetime(ctx.song);
  const [change, setChange] = useState(can);
  const ok = bpm >= 20 && bpm <= 400;
  const step = (d: number) => setBpm((b) => Math.max(20, Math.min(400, Math.round(b + d))));
  const stepBtn = cn('focus-ring rounded-lg bg-ink-800 font-mono text-ink-50 hover:bg-ink-700', dock ? 'h-12 w-12 text-[18px]' : 'h-9 w-9 text-[15px]');
  return (
    <>
      <span className="flex items-center gap-1">
        <button type="button" className={stepBtn} aria-label="Slower" onClick={() => step(-5)}>
          −
        </button>
        <input type="number" min={20} max={400} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} aria-label="Beats per minute" className={cn(field(dock), 'w-20 text-center')} data-testid="sheet-tempo-bpm" />
        <button type="button" className={stepBtn} aria-label="Faster" onClick={() => step(5)}>
          +
        </button>
      </span>
      <select value={unit} onChange={(e) => setUnit(e.target.value as TempoUnit)} aria-label="Beat" className={field(dock)}>
        {(Object.keys(UNIT_NAME) as TempoUnit[]).map((u) => (
          <option key={u} value={u}>
            {UNIT_LABEL[u]} {UNIT_NAME[u]}
          </option>
        ))}
      </select>
      <input value={text} maxLength={40} onChange={(e) => setText(e.target.value)} placeholder="Words (optional): Andante…" aria-label="Tempo words" className={cn(field(dock), 'min-w-0 flex-1')} />
      <label className={cn('flex items-center gap-2 text-ink-200', dock ? 'text-[13px]' : 'text-[12px]', !can && 'opacity-50')}>
        <input type="checkbox" checked={change && can} disabled={!can} onChange={(e) => setChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent-500)]" data-testid="sheet-tempo-change" />
        Change playback speed from here
      </label>
      {!can && <span className="w-full text-[11.5px] text-ink-300">This song plays a recording, so the tempo mark is shown but the playback speed stays the same.</span>}
      <button
        type="button"
        disabled={!ok}
        className={applyBtn(dock)}
        onClick={() => {
          setTempoAt(m, Math.round(bpm), unit, text, change && can);
          done();
        }}
        data-testid="sheet-tempo-apply"
      >
        Apply
      </button>
    </>
  );
}

/** The desktop edit bar's Marks / Bar buttons with their popovers. */
export function MarkPanelButtons() {
  const panel = useSheetUi((s) => s.panel);
  const set = useSheetUi((s) => s.set);
  const toggle = (p: 'marks' | 'bar') => set({ panel: panel === p ? null : p, picker: null, viaKey: false });
  const btn = (p: 'marks' | 'bar', label: string, title: string) => (
    <button
      type="button"
      data-sheet-panel-button
      aria-expanded={panel === p}
      title={title}
      onPointerDown={(e) => e.pointerType === 'mouse' && e.preventDefault()}
      onClick={() => toggle(p)}
      className={cn('focus-ring inline-flex h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium', panel === p ? 'bg-accent-500/25 text-accent-200 ring-1 ring-accent-500/50' : 'text-ink-100 hover:bg-ink-700/70')}
      data-testid={`sheet-${p}-button`}
    >
      {label}
      <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden className="fill-current opacity-70">
        <path d="M0 0h9L4.5 6z" />
      </svg>
    </button>
  );
  const close = () => set({ panel: null, picker: null });
  return (
    <span className="relative inline-flex items-center gap-0.5">
      {btn('marks', 'Marks', 'Fingering, articulations, slurs, dynamics, pedal and words')}
      {btn('bar', 'Bar', 'Key, time and tempo changes')}
      {panel === 'marks' && (
        <Popover onClose={close} testId="sheet-marks-panel" label="Marks">
          <MarksTools dock={false} />
        </Popover>
      )}
      {panel === 'bar' && (
        <Popover onClose={close} testId="sheet-bar-panel" label="Bar">
          <BarTools dock={false} />
        </Popover>
      )}
    </span>
  );
}

/** Whether a SheetMark is a positional mark (dynamics, hairpin, words). */
export const isPositional = (m: SheetMark) => m.kind !== 'slur';
export { pedalSel };
