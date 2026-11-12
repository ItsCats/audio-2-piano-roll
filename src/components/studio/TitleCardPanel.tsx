/**
 * "Title page" and "End card" sections of the Export video dialog. Everything about them lives
 * here (and in src/lib/render/titleCard); the dialog only places this panel, adds the cards' length
 * to the shown video length and passes `titleCardJob()` to the export.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { create } from 'zustand';
import { ColorInput, Segmented, Select, Slider, Toggle, cn } from '../ui';
import { MediaPicker } from './panels/LookPanel';
import { TitleCardPreview } from './TitleCardPreview';
import { useFontEpoch, useStudioBackdrop, useTitleFonts, useTitleImages } from './useTitleAssets';
import { useTitleCard, titleCardSettings } from '../../state/titleCardStore';
import { outputSize, type ExportSettings } from '../../lib/export/types';
import type { VisualSettings } from '../../lib/render/settings';
import { TitleCardCache, drawTitleCard } from '../../lib/render/titleCard/draw';
import { DEFAULT_DIM, FONT_LABELS, TITLE_PRESETS, getPreset, presetFontId, resolveLook, type ResolvedLook } from '../../lib/render/titleCard/presets';
import { FILL_PATTERNS, getFillTile, patternInfo } from '../../lib/render/titleCard/patterns';
import { downscaleUpload, MAX_FILL_EDGE } from '../../lib/render/titleCard/assets';
import { endCardText, textForSong } from '../../lib/render/titleCard/settings';
import { END_LAYOUT, titleCardsSeconds, type TitleCardJob } from '../../lib/render/titleCard/exportHooks';
import type { DividerId, FillKind, FillPatternId, FillScope, TitleBgKind, TitleFontId, TitleLook, TitleText } from '../../lib/render/titleCard/types';

interface SongLike {
  id: string;
  title: string;
  artist?: string;
}

/** Messages from the last export (e.g. a font that did not load). */
const useTitleWarning = create<{ message: string | null }>(() => ({ message: null }));

/** The title page / end card part of an export job (undefined when both are off). */
export function titleCardJob(song: SongLike, visual: VisualSettings): TitleCardJob | undefined {
  const settings = titleCardSettings();
  if (!settings.enabled && !settings.end.enabled) return undefined;
  useTitleWarning.setState({ message: null });
  return {
    settings,
    text: textForSong(song, settings),
    hint: { accent: visual.rightColor },
    onWarning: (message) => useTitleWarning.setState({ message }),
  };
}

/** Seconds the title page and end card add to the video (re-renders when they change). */
export function useTitleCardSeconds(song: SongLike | null, fps: number): number {
  // a number, so the dialog re-renders only when the length really changes (not on every key)
  return useTitleCard((s) => (!song || (!s.enabled && !s.end.enabled) ? 0 : titleCardsSeconds({ settings: s, text: textForSong(song, s) }, fps)));
}

const inputCls = 'focus-ring h-9 w-full min-w-0 rounded-[10px] border border-ink-600 bg-ink-800 px-2.5 text-[13px] text-ink-50 placeholder:text-ink-500';

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12.5px] text-ink-200">{label}</span>
      <input className={inputCls} value={value} placeholder={placeholder} maxLength={200} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">{children}</span>;
}

/** Small preview of each style with the song's own title. */
function StyleChip({ id, active, text, onClick, fontsVersion, hint }: { id: TitleLook['preset']; active: boolean; text: TitleText; onClick: () => void; fontsVersion: number; hint: { accent?: string } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cache = useMemo(() => new TitleCardCache(), []);
  const look = useMemo(() => resolveLook({ ...DEFAULT_CHIP_LOOK, preset: id }, hint), [id, hint]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => {
      c.width = 192;
      c.height = 108;
      drawTitleCard(c.getContext('2d')!, 192, 108, look, { title: text.title || 'Title', subtitle: '', composer: text.composer, credit: '', small: '' }, {}, 3, cache, { duration: 4, reveal: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [look, text.title, text.composer, fontsVersion, cache]);
  useEffect(() => () => cache.dispose(), [cache]);
  const name = getPreset(id).name;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${name} style`}
      className={cn('focus-ring flex min-w-0 flex-col gap-1 rounded-lg p-1 text-[11.5px] ring-2 transition', active ? 'text-ink-50 ring-accent-500' : 'text-ink-300 ring-transparent hover:ring-ink-500')}
    >
      <canvas ref={ref} className="aspect-video w-full rounded-md" aria-hidden />
      <span className="truncate">{name}</span>
    </button>
  );
}

const DEFAULT_CHIP_LOOK: TitleLook = {
  preset: 'classic',
  font: null,
  fill: null,
  fillColor: null,
  gradient: null,
  gradientAngle: null,
  pattern: null,
  fillImageId: null,
  fillScope: null,
  divider: null,
  bg: null,
  bgColor: null,
  bgGradient: null,
  bgImageId: null,
  dim: null,
  textColor: null,
  streaks: false,
  sparkles: false,
  zoom: false,
  shine: false,
};

function PatternSwatch({ id, active, onClick }: { id: FillPatternId; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const info = patternInfo(id);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    if (info.stops) {
      const g = ctx.createLinearGradient(0, 0, 64, 64);
      for (const [o, col] of info.stops) g.addColorStop(o, col);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    } else {
      const tile = getFillTile(id, 1024);
      if (tile) ctx.drawImage(tile as CanvasImageSource, 0, 0, 512, 512, 0, 0, 64, 64);
    }
  }, [id, info]);
  return (
    <button
      type="button"
      onClick={onClick}
      title={info.name}
      aria-label={`${info.name} pattern`}
      aria-pressed={active}
      className={cn('focus-ring flex flex-col items-center gap-1 rounded-lg p-0.5 text-[10.5px]', active ? 'text-ink-50' : 'text-ink-300')}
    >
      <canvas ref={ref} className={cn('h-9 w-9 rounded-full ring-2', active ? 'ring-accent-500' : 'ring-white/15')} aria-hidden />
      <span className="max-w-[4.5rem] truncate">{info.name}</span>
    </button>
  );
}

const hexOr = (v: string | null | undefined, fallback: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
const solidHex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff');

function Customize({ look, resolved, setLook }: { look: TitleLook; resolved: ResolvedLook; setLook: (p: Partial<TitleLook>) => void }) {
  const preset = getPreset(look.preset);
  const fill: FillKind = look.fill ?? (preset.fill.kind === 'pattern' ? 'pattern' : preset.fill.kind === 'gradient' ? 'gradient' : 'solid');
  const pattern = look.pattern ?? (preset.fill.kind === 'pattern' ? preset.fill.id : 'bouquet');
  const bg: TitleBgKind = look.bg ?? 'style';
  return (
    <div className="flex flex-col gap-3">
      <Select<TitleFontId | ''>
        label="Font"
        value={look.font ?? ''}
        onChange={(v) => setLook({ font: v || null })}
        options={[{ value: '', label: `Style default (${FONT_LABELS[presetFontId(preset)]})` }, ...(Object.keys(FONT_LABELS) as TitleFontId[]).map((f) => ({ value: f, label: FONT_LABELS[f] }))]}
      />
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] text-ink-200">Letters</span>
        <Segmented<FillKind>
          size="sm"
          className="w-full"
          ariaLabel="Letters"
          value={fill}
          onChange={(v) => setLook({ fill: v })}
          options={[
            { value: 'solid', label: 'Colour' },
            { value: 'gradient', label: 'Gradient' },
            { value: 'pattern', label: 'Pattern' },
            { value: 'image', label: 'My image' },
          ]}
        />
        {fill === 'solid' && <ColorInput label="Letter colour" value={hexOr(look.fillColor, solidHex(resolved.lines.title.color))} onChange={(fillColor) => setLook({ fill: 'solid', fillColor })} />}
        {fill === 'gradient' && (
          <>
            <ColorInput label="From" value={hexOr(look.gradient?.[0], '#f6d8ff')} onChange={(c) => setLook({ gradient: [c, hexOr(look.gradient?.[1], '#8fb4ff')] })} />
            <ColorInput label="To" value={hexOr(look.gradient?.[1], '#8fb4ff')} onChange={(c) => setLook({ gradient: [hexOr(look.gradient?.[0], '#f6d8ff'), c] })} />
            <Slider label="Direction" min={0} max={180} step={5} value={look.gradientAngle ?? 0} onChange={(gradientAngle) => setLook({ gradientAngle })} format={(x) => `${x}°`} />
          </>
        )}
        {fill === 'pattern' && (
          <div className="grid grid-cols-5 gap-1 sm:grid-cols-5" role="group" aria-label="Pattern">
            {FILL_PATTERNS.map((p) => (
              <PatternSwatch key={p.id} id={p.id} active={pattern === p.id} onClick={() => setLook({ fill: 'pattern', pattern: p.id })} />
            ))}
          </div>
        )}
        {fill === 'image' && (
          <>
            <MediaPicker kind="image" purpose="title" what="image" selectedId={look.fillImageId} onSelect={(fillImageId) => setLook({ fill: 'image', fillImageId })} prepare={(f) => downscaleUpload(f, MAX_FILL_EDGE)} />
            <p className="text-[11.5px] text-ink-400">Your image stays on this device.</p>
          </>
        )}
      </div>
      <Select<FillScope>
        label="Use on"
        value={look.fillScope ?? preset.fillScope}
        onChange={(fillScope) => setLook({ fillScope })}
        options={[
          { value: 'title', label: 'Title only' },
          { value: 'main', label: 'Title and composer' },
          { value: 'all', label: 'All main lines' },
        ]}
      />
      <Select<DividerId>
        label="Divider"
        value={look.divider ?? preset.divider}
        onChange={(divider) => setLook({ divider })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'rules', label: 'Lines' },
          { value: 'diamond', label: 'Lines with diamond' },
          { value: 'vine', label: 'Vine' },
          { value: 'scroll', label: 'Scroll' },
        ]}
      />
      <Select<TitleBgKind>
        label="Background"
        value={bg}
        onChange={(v) => setLook({ bg: v === 'style' ? null : v })}
        options={[
          { value: 'style', label: 'Style default' },
          { value: 'color', label: 'Colour' },
          { value: 'gradient', label: 'Gradient' },
          { value: 'video', label: 'Same as video' },
          { value: 'image', label: 'My image' },
        ]}
      />
      {bg === 'color' && <ColorInput label="Background colour" value={hexOr(look.bgColor, '#000000')} onChange={(bgColor) => setLook({ bgColor })} />}
      {bg === 'gradient' && (
        <>
          <ColorInput label="Top" value={hexOr(look.bgGradient?.[0], '#1b1430')} onChange={(c) => setLook({ bgGradient: [c, hexOr(look.bgGradient?.[1], '#05040a')] })} />
          <ColorInput label="Bottom" value={hexOr(look.bgGradient?.[1], '#05040a')} onChange={(c) => setLook({ bgGradient: [hexOr(look.bgGradient?.[0], '#1b1430'), c] })} />
        </>
      )}
      {bg === 'image' && <MediaPicker kind="image" purpose="title" what="image" selectedId={look.bgImageId} onSelect={(bgImageId) => setLook({ bgImageId })} prepare={(f) => downscaleUpload(f)} />}
      {(bg === 'image' || bg === 'video') && <Slider label="Dim" min={0} max={0.8} step={0.05} value={look.dim ?? DEFAULT_DIM} onChange={(dim) => setLook({ dim })} format={(x) => `${Math.round(x * 100)}%`} />}
      {/* only for lines that are not filled with the letters' pattern / image */}
      {(resolved.fill.kind === 'solid' || resolved.fillRoles.length < 3) && (
        <ColorInput label="Text colour" value={hexOr(look.textColor, solidHex(resolved.lines.subtitle.color))} onChange={(textColor) => setLook({ textColor })} />
      )}
      <Toggle label="Light streaks" checked={resolved.streaks} onChange={(streaks) => setLook({ streaks })} />
      <Toggle label="Sparkles" checked={resolved.sparkles} onChange={(sparkles) => setLook({ sparkles })} />
      <Toggle label="Slow zoom" checked={resolved.zoom} onChange={(zoom) => setLook({ zoom })} />
      <Toggle label="Shine" checked={resolved.shine} onChange={(shine) => setLook({ shine })} />
    </div>
  );
}

export function TitleCardPanel({ song, exportSettings, visual }: { song: SongLike; exportSettings: ExportSettings; visual: VisualSettings }) {
  const s = useTitleCard();
  const warning = useTitleWarning((w) => w.message);
  const { width, height } = outputSize(exportSettings);
  const hint = useMemo(() => ({ accent: visual.rightColor }), [visual.rightColor]);
  const resolved = useMemo(() => resolveLook(s.look, hint), [s.look, hint]);
  const text0 = textForSong(song, s);
  const endText0 = endCardText(s.end, text0);
  // stable objects while the words stay the same (they key the previews and the font loading)
  const textKey = JSON.stringify([text0, endText0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const [text, endText] = useMemo(() => [text0, endText0], [textKey]);
  const anyOn = s.enabled || s.end.enabled;
  const images = useTitleImages(resolved);
  const backdrop = useStudioBackdrop(anyOn && resolved.bg.kind === 'video', visual, Math.round(width / 3), Math.round(height / 3));
  const cardImages = useMemo(() => ({ ...images, backdrop }), [images, backdrop]);
  const chipTexts = useMemo(() => [{ title: text.title || 'Title', subtitle: '', composer: text.composer, credit: '', small: '' }], [text.title, text.composer]);
  const texts = useMemo(() => [text, endText], [text, endText]);
  useTitleFonts(resolved, anyOn ? texts : []);
  useAllStyleFonts(s.enabled, chipTexts, hint);
  const fonts = useFontEpoch();
  const chipFonts = fonts;
  const [open, setOpen] = useState(false);
  const customizeId = useId();
  const setText = (patch: Partial<TitleText>) => s.setSongText(song.id, patch);

  return (
    <>
      <div className="flex flex-col gap-3 border-t border-ink-700 p-4">
        <Heading>Title page</Heading>
        <Toggle label="Add a title page" hint="Shown at the start, without sound" checked={s.enabled} onChange={s.setEnabled} />
        {s.enabled && (
          <>
            {/* stays in view while you type and scroll the settings (smaller on phones) */}
            <TitleCardPreview look={resolved} text={text} width={width} height={height} duration={s.duration} images={cardImages} fontsVersion={fonts} label="Title page preview" compact className="sticky top-0 z-10 -mx-4 bg-ink-850 px-4 pt-1 pb-2" />
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-ink-200">Style</span>
              <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Style">
                {TITLE_PRESETS.map((p) => (
                  <StyleChip key={p.id} id={p.id} active={s.look.preset === p.id} text={text} hint={hint} fontsVersion={chipFonts} onClick={() => s.applyPreset(p.id)} />
                ))}
              </div>
            </div>
            <Field label="Title" value={text.title} onChange={(title) => setText({ title })} />
            <Field label="Subtitle" value={text.subtitle} placeholder="e.g. Suite Bergamasque or No. 1" onChange={(subtitle) => setText({ subtitle })} />
            <Field label="Composer or artist" value={text.composer} onChange={(composer) => setText({ composer })} />
            <Field label="Credit" value={text.credit} placeholder="e.g. Arranged by … or your channel name" onChange={(credit) => setText({ credit })} />
            <Field label="Small line" value={text.small} placeholder="e.g. For my teacher" onChange={(small) => setText({ small })} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
              <span className="text-ink-400">Leave a line empty to hide it.</span>
              <button type="button" className="focus-ring inline-flex items-center gap-1 rounded text-accent-300 hover:text-accent-200" onClick={() => s.resetSongText(song.id)}>
                <RotateCcw size={12} /> Reset to song
              </button>
            </div>
            <div className="rounded-xl border border-ink-700">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={customizeId}
                onClick={() => setOpen((o) => !o)}
                className="focus-ring flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] text-ink-100 hover:bg-ink-800"
              >
                Customize
                <span className="text-ink-400" aria-hidden>
                  {open ? '−' : '+'}
                </span>
              </button>
              {open && (
                <div id={customizeId} className="flex flex-col gap-3 border-t border-ink-700 p-3">
                  <Customize look={s.look} resolved={resolved} setLook={s.setLook} />
                  <button type="button" className="focus-ring inline-flex items-center gap-1 self-start rounded text-[11.5px] text-accent-300 hover:text-accent-200" onClick={() => s.applyPreset(s.look.preset)}>
                    <RotateCcw size={12} /> Reset style
                  </button>
                </div>
              )}
            </div>
            <Slider label="Length" min={2} max={10} step={0.5} value={s.duration} onChange={s.setDuration} format={(x) => `${x} s`} />
          </>
        )}
        <p className="text-[12px] text-warn empty:hidden" aria-live="polite">
          {warning}
        </p>
      </div>
      <div className="flex flex-col gap-3 border-t border-ink-700 p-4">
        <Heading>End card</Heading>
        <Toggle label="Add an end card" hint="Shown at the end, after the music" checked={s.end.enabled} onChange={(enabled) => s.setEnd({ enabled })} />
        {s.end.enabled && (
          <>
            <TitleCardPreview look={resolved} text={endText} width={width} height={height} duration={s.end.duration} images={cardImages} fontsVersion={fonts} layout={END_LAYOUT} end label="End card preview" />
            <Field label="Main line" value={s.end.main} onChange={(main) => s.setEnd({ main })} />
            <Field label="Credit" value={s.end.credit ?? ''} placeholder={text.credit ? `Same as the title page (${text.credit})` : 'Same as the title page'} onChange={(credit) => s.setEnd({ credit: credit.trim() ? credit : null })} />
            <Field label="Small line" value={s.end.small} placeholder="e.g. See you next time" onChange={(small) => s.setEnd({ small })} />
            <Slider label="Length" min={2} max={10} step={0.5} value={s.end.duration} onChange={(duration) => s.setEnd({ duration })} format={(x) => `${x} s`} />
            {!s.enabled && <p className="text-[11.5px] text-ink-400">It uses the title page style. Turn on the title page to change it.</p>}
          </>
        )}
      </div>
    </>
  );
}

/** Loads the title fonts of every style for the style chips (only while the title page is on). */
function useAllStyleFonts(on: boolean, texts: TitleText[], hint: { accent?: string }): void {
  const key = JSON.stringify(texts);
  useEffect(() => {
    if (!on) return;
    // a font that arrives bumps the font epoch (useFontEpoch), which redraws the chips
    void import('../../lib/render/titleCard/fonts').then(({ ensureTitleFonts }) => Promise.all(TITLE_PRESETS.map((p) => ensureTitleFonts(resolveLook({ ...DEFAULT_CHIP_LOOK, preset: p.id }, hint), texts))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);
}
