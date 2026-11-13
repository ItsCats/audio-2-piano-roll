import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ImagePlus, Trash2, RotateCcw, Ban, Shapes, Image as ImageIcon } from 'lucide-react';
import { useSettings } from '../../../state/settingsStore';
import { BACKGROUND_PRESETS } from '../../../lib/render/backgrounds';
import { DECAL_PATTERNS, getPatternTile } from '../../../lib/render/decals';
import { KEYBOARD_THEMES, VISUAL_THEMES, applyTheme, type DecalSource, type KeyboardRange } from '../../../lib/render/settings';
import { Button, ColorInput, Section, Segmented, Select, Slider, Toggle, cn } from '../../ui';
import { deleteMedia, listMedia, newId, saveMedia, type MediaItem } from '../../../lib/storage/db';
import { toast } from '../../../state/toastStore';
import { useTitleCard } from '../../../state/titleCardStore';
import { useCanvasRestored } from '../useCanvasRestored';

const MAX_MEDIA = 200 * 1024 * 1024;

function PresetThumb({ id, active, onClick, name }: { id: string; active: boolean; onClick: () => void; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const restored = useCanvasRestored(ref);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = 96;
    c.height = 54;
    const p = BACKGROUND_PRESETS.find((b) => b.id === id);
    if (p) p.draw(c.getContext('2d')!, 96, 54);
  }, [id, restored]);
  return (
    <button
      onClick={onClick}
      title={name}
      aria-label={`${name} background`}
      aria-pressed={active}
      className={cn('focus-ring overflow-hidden rounded-lg ring-2 transition', active ? 'ring-accent-500' : 'ring-transparent hover:ring-ink-500')}
    >
      <canvas ref={ref} className="block h-auto w-full" />
    </button>
  );
}

/** Pattern tile size used for gallery thumbnails (cached by decals.ts, so generated once per pattern). */
const THUMB_TILE = 256;

/** Draws a pattern tile into a small canvas, clipped like a note with a glowing outline. */
function PatternThumb({ id, name, active, onClick }: { id: string; name: string; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const restored = useCanvasRestored(ref);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // back the canvas with as many device pixels as it covers so thumbs stay crisp on HiDPI screens
    const css = c.clientWidth || 72;
    const S = Math.max(64, Math.min(THUMB_TILE, Math.round(css * (window.devicePixelRatio || 1))));
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, S, S);
    const tile = getPatternTile(id, THUMB_TILE);
    if (tile) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tile as CanvasImageSource, 0, 0, THUMB_TILE, THUMB_TILE, 0, 0, S, S);
    }
    else {
      ctx.fillStyle = '#1b1b22';
      ctx.fillRect(0, 0, S, S);
    }
  }, [id, restored]);
  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      aria-label={`${name} decal pattern`}
      aria-pressed={active}
      className={cn(
        'focus-ring group relative aspect-square overflow-hidden rounded-[10px] ring-2 transition',
        active ? 'ring-accent-500' : 'ring-transparent hover:ring-ink-500',
      )}
    >
      <canvas ref={ref} className="block h-full w-full transition-transform duration-200 group-hover:scale-[1.06]" />
      <span className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]" />
    </button>
  );
}

/** Tiny inline swatch of a pattern (used on theme buttons). */
function PatternSwatch({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const restored = useCanvasRestored(ref);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = 32;
    c.height = 32;
    const tile = getPatternTile(id, 128);
    if (tile) c.getContext('2d')?.drawImage(tile as CanvasImageSource, 0, 0, 128, 128, 0, 0, 32, 32);
  }, [id, restored]);
  return <canvas ref={ref} className="h-4 w-4 rounded-[4px] ring-1 ring-white/40" aria-hidden />;
}

/**
 * What an upload was added for. Stored as an extra field on the IndexedDB record (structured clone keeps it);
 * records without one predate decals and count as backgrounds.
 */
export type MediaPurpose = 'background' | 'decal' | 'title';
type PickerMedia = MediaItem & { purpose?: MediaPurpose };

// Background and decal pickers share the media store; this lets each list refresh when the other changes it.
const mediaListeners = new Set<() => void>();
const notifyMedia = () => mediaListeners.forEach((f) => f());

/**
 * Upload button + list of stored images/videos. Used by both the background and the note-decal
 * pickers; each passes its own selection so they stay independent.
 */
export function MediaPicker({
  kind,
  purpose,
  selectedId,
  onSelect,
  what,
  prepare,
}: {
  kind: 'image' | 'video';
  /** only files uploaded for this purpose are listed (plus the current selection) */
  purpose: MediaPurpose;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** user-facing noun for error messages, e.g. "background" or "decal" */
  what: string;
  /** turns the chosen file into what is stored (e.g. a downscaled copy); runs on this device only */
  prepare?: (f: File) => Promise<{ blob: Blob; type: string }>;
}) {
  const [items, setItems] = useState<PickerMedia[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => void listMedia().then((l) => alive && setItems(l));
    refresh();
    mediaListeners.add(refresh);
    return () => {
      alive = false;
      mediaListeners.delete(refresh);
    };
  }, []);
  const onFile = async (f: File) => {
    const ok = kind === 'video' ? /^video\/(mp4|webm|quicktime)$/.test(f.type) : /^image\/(jpeg|png|webp)$/.test(f.type);
    if (!ok) {
      toast.error(`Unsupported ${what}`, kind === 'video' ? 'Use MP4 or WebM videos.' : 'Use JPG, PNG or WEBP images.');
      return;
    }
    if (f.size > MAX_MEDIA) {
      toast.error('File too large', `${what[0].toUpperCase()}${what.slice(1)}s are limited to 200 MB.`);
      return;
    }
    try {
      const stored = prepare ? await prepare(f) : { blob: f, type: f.type };
      const item: PickerMedia = { id: newId(), name: f.name, type: stored.type, kind, blob: stored.blob, createdAt: Date.now(), purpose };
      await saveMedia(item);
      onSelect(item.id);
      notifyMedia();
    } catch (e) {
      toast.error(`Could not store ${what}`, (e as Error).message);
    }
  };
  const remove = async (m: MediaItem) => {
    await deleteMedia(m.id);
    // the same file may be in use as background and decal: clear every reference to it
    const st = useSettings.getState();
    if (st.visual.background.mediaId === m.id) st.setBackground({ mediaId: null });
    if (st.visual.decal.mediaId === m.id) st.setDecal({ mediaId: null });
    useTitleCard.getState().forgetMedia(m.id);
    notifyMedia();
  };
  const list = items.filter((i) => i.kind === kind && ((i.purpose ?? 'background') === purpose || i.id === selectedId));
  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" variant="subtle" icon={<ImagePlus size={15} />} onClick={() => input.current?.click()}>
        Upload {kind === 'video' ? 'video (MP4/WebM)' : 'image (JPG/PNG/WEBP)'}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={`Upload ${what} ${kind}`}
        accept={kind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp'}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />
      {list.length > 0 && (
        <ul className="flex flex-col gap-1">
          {list.map((m) => (
            <li
              key={m.id}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px]',
                selectedId === m.id ? 'bg-accent-500/15 text-ink-50' : 'text-ink-200 hover:bg-ink-800',
              )}
            >
              <button className="min-w-0 flex-1 truncate text-left" aria-pressed={selectedId === m.id} onClick={() => onSelect(m.id)}>
                {m.name}
              </button>
              <button className="text-ink-400 hover:text-bad" aria-label={`Delete ${m.name}`} onClick={() => void remove(m)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A Slider that shows every value instantly but pushes it to the settings store at most once per
 * `every` ms (plus the final value). For settings that are expensive to apply live: decal size,
 * strength and tint make decals.ts resample / rebake the decal for each new value.
 */
function CoalescedSlider({ value, onChange, every = 120, ...rest }: ComponentProps<typeof Slider> & { every?: number }) {
  const [local, setLocal] = useState<number | null>(null);
  const [flushes, setFlushes] = useState(0);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const last = useRef(0);
  const cb = useRef(onChange);
  cb.current = onChange;
  const flush = () => {
    timer.current = null;
    if (pending.current === null) return;
    const x = pending.current;
    pending.current = null;
    last.current = performance.now();
    cb.current(x);
    setFlushes((n) => n + 1);
  };
  useEffect(
    () => () => {
      // unmounting mid-drag: don't lose the last value
      if (timer.current !== null) window.clearTimeout(timer.current);
      flush();
    },
    [],
  );
  // once nothing is pending, follow the store again (it now holds the last value we sent, or a
  // newer one from e.g. a theme switch). Re-checked after every flush, so it can't get stuck.
  useEffect(() => {
    if (local !== null && pending.current === null && timer.current === null) setLocal(null);
  }, [value, local, flushes]);
  return (
    <Slider
      {...rest}
      value={local ?? value}
      onChange={(x) => {
        setLocal(x);
        pending.current = x;
        if (timer.current !== null) return;
        const wait = Math.max(0, every - (performance.now() - last.current));
        if (wait === 0) flush();
        else timer.current = window.setTimeout(flush, wait);
      }}
    />
  );
}

/** Indented group of controls that belongs to the toggle right above it. */
function SubControls({ children }: { children: ReactNode }) {
  return <div className="-mt-1 ml-1 flex flex-col gap-3 border-l border-ink-700 pl-3">{children}</div>;
}

export function LookPanel() {
  const v = useSettings((s) => s.visual);
  const setVisual = useSettings((s) => s.setVisual);
  const replaceVisual = useSettings((s) => s.replaceVisual);
  const setBackground = useSettings((s) => s.setBackground);
  const setDecal = useSettings((s) => s.setDecal);
  const setEffects = useSettings((s) => s.setEffects);
  const resetVisual = useSettings((s) => s.resetVisual);
  const bg = v.background;
  const decal = v.decal;
  const fx = v.effects;
  const activePattern = DECAL_PATTERNS.find((p) => p.id === decal.patternId);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div>
      <Section
        title="Themes"
        actions={
          <button className="flex items-center gap-1 text-[11.5px] text-ink-300 hover:text-ink-50" onClick={resetVisual}>
            <RotateCcw size={12} /> Reset
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          {VISUAL_THEMES.map((t) => {
            const c1 = t.patch.colorMode === 'pitch' ? '#ff5a5f' : t.patch.colorMode === 'single' ? t.patch.singleColor : t.patch.rightColor;
            const c2 = t.patch.colorMode === 'pitch' ? '#3cb8f0' : t.patch.colorMode === 'single' ? t.patch.singleColor : t.patch.leftColor;
            return (
              <button
                key={t.id}
                onClick={() => replaceVisual(applyTheme(v, t.id))}
                className="focus-ring flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-2 text-left text-[12.5px] text-ink-100 hover:border-ink-500"
              >
                <span className="flex items-center gap-0.5">
                  <span className="h-4 w-1.5 rounded-sm" style={{ background: c1 }} />
                  <span className="h-4 w-1.5 rounded-sm" style={{ background: c2 }} />
                  {t.patch.decal?.source === 'pattern' && t.patch.decal.patternId && <PatternSwatch id={t.patch.decal.patternId} />}
                </span>
                {t.name}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Notes">
        <Segmented
          size="sm"
          value={v.colorMode}
          onChange={(colorMode) => setVisual({ colorMode })}
          options={[
            { value: 'hand', label: 'By hand' },
            { value: 'pitch', label: 'Rainbow' },
            { value: 'single', label: 'Single' },
          ]}
        />
        {v.colorMode === 'hand' && (
          <>
            <ColorInput label="Right hand" value={v.rightColor} onChange={(rightColor) => setVisual({ rightColor })} />
            <ColorInput label="Left hand" value={v.leftColor} onChange={(leftColor) => setVisual({ leftColor })} />
          </>
        )}
        {v.colorMode === 'single' && <ColorInput label="Note color" value={v.singleColor} onChange={(singleColor) => setVisual({ singleColor })} />}
        <Slider label="Note speed (seconds visible)" min={0.8} max={10} step={0.1} value={v.lookahead} onChange={(lookahead) => setVisual({ lookahead })} format={(x) => `${x.toFixed(1)}s`} />
        <Slider label="Note width" min={0.4} max={1} value={v.noteWidth} onChange={(noteWidth) => setVisual({ noteWidth })} format={pct} />
        <Slider label="Opacity" min={0.2} max={1} value={v.noteOpacity} onChange={(noteOpacity) => setVisual({ noteOpacity })} format={pct} />
        <Slider label="Corner radius" min={0} max={14} step={1} value={v.cornerRadius} onChange={(cornerRadius) => setVisual({ cornerRadius })} format={(x) => `${x}px`} />
        <Slider
          label="Falling glow"
          min={0}
          max={1}
          value={v.fallingGlow}
          onChange={(fallingGlow) => setVisual({ fallingGlow })}
          format={(x) => (x <= 0 ? 'Off' : pct(x))}
        />
        <Slider
          label="Note brightness"
          min={0}
          max={1}
          value={v.noteBrightness}
          onChange={(noteBrightness) => setVisual({ noteBrightness })}
          format={(x) => (x <= 0 ? 'Off' : pct(x))}
        />
        <Slider label="Glow when played" min={0} max={1} value={v.glow} onChange={(glow) => setVisual({ glow })} format={(x) => (x <= 0 ? 'Off' : pct(x))} />
        <Slider label="Border" min={0} max={3} step={0.5} value={v.borderWidth} onChange={(borderWidth) => setVisual({ borderWidth })} format={(x) => `${x}px`} />
        {v.borderWidth > 0 && <ColorInput label="Border color" value={v.borderColor} onChange={(borderColor) => setVisual({ borderColor })} />}
        <Toggle label="Gradient fill" checked={v.gradient} onChange={(gradient) => setVisual({ gradient })} />
        <Toggle label="Drop shadow" checked={v.shadow} onChange={(shadow) => setVisual({ shadow })} />
        <Toggle label="Highlight upcoming notes" checked={v.upcomingHighlight} onChange={(upcomingHighlight) => setVisual({ upcomingHighlight })} />
      </Section>

      <Section title="Note decal">
        <Segmented<DecalSource>
          size="sm"
          ariaLabel="Decal source"
          value={decal.source}
          onChange={(source) => setDecal({ source })}
          options={[
            { value: 'none', label: <span className="flex items-center justify-center gap-1.5"><Ban size={13} />None</span> },
            { value: 'pattern', label: <span className="flex items-center justify-center gap-1.5"><Shapes size={13} />Pattern</span> },
            { value: 'image', label: <span className="flex items-center justify-center gap-1.5"><ImageIcon size={13} />My image</span> },
          ]}
        />
        {decal.source === 'none' && <p className="text-[12px] leading-relaxed text-ink-300">Paint a pattern or your own picture inside every note.</p>}
        {decal.source === 'pattern' &&
          (DECAL_PATTERNS.length > 0 ? (
            <>
              <div className="grid grid-cols-4 gap-2" role="group" aria-label="Decal patterns">
                {DECAL_PATTERNS.map((p) => (
                  <PatternThumb key={p.id} id={p.id} name={p.name} active={decal.patternId === p.id} onClick={() => setDecal({ patternId: p.id })} />
                ))}
              </div>
              {activePattern && <p className="-mt-1 text-[12px] text-ink-300">{activePattern.name}</p>}
            </>
          ) : (
            <p className="text-[12px] text-ink-300">No patterns available.</p>
          ))}
        {decal.source === 'image' && (
          <>
            <MediaPicker kind="image" purpose="decal" what="decal" selectedId={decal.mediaId} onSelect={(mediaId) => setDecal({ mediaId })} />
            {!decal.mediaId && <p className="text-[12px] leading-relaxed text-ink-300">Upload a picture (flowers, a texture, a photo…) or pick one you added before.</p>}
          </>
        )}
        {decal.source !== 'none' && (
          <>
            <CoalescedSlider label="Size" min={0.25} max={3} value={decal.scale} onChange={(scale) => setDecal({ scale })} format={(x) => `${x.toFixed(2)}×`} />
            <CoalescedSlider label="Strength" min={0} max={1} value={decal.opacity} onChange={(opacity) => setDecal({ opacity })} format={pct} />
            {/* step matches the tint quantisation in decals.ts baked(), so no drag step is a wasted rebake */}
            <CoalescedSlider label="Color tint" min={0} max={1} step={0.02} value={decal.tint} onChange={(tint) => setDecal({ tint })} format={pct} />
            <Segmented
              size="sm"
              ariaLabel="Decal anchor"
              value={decal.anchor}
              onChange={(anchor) => setDecal({ anchor })}
              options={[
                { value: 'note', label: 'Moves with note', title: 'Each note carries its own piece of the decal' },
                { value: 'screen', label: 'Fixed to screen', title: 'Notes act as windows onto one still picture' },
              ]}
            />
          </>
        )}
      </Section>

      <Section title="Effects">
        <Toggle label="Light bursts" hint="Bright flares where notes hit the keys" checked={fx.bursts} onChange={(bursts) => setEffects({ bursts })} />
        {fx.bursts && (
          <SubControls>
            <Slider label="Burst intensity" min={0.05} max={1} value={fx.burstIntensity} onChange={(burstIntensity) => setEffects({ burstIntensity })} format={pct} />
          </SubControls>
        )}
        <Toggle label="Sparkle dust" hint="Glitter that floats up after notes play" checked={fx.dust} onChange={(dust) => setEffects({ dust })} />
        {fx.dust && (
          <SubControls>
            <Slider label="Dust amount" min={0.05} max={1} value={fx.dustAmount} onChange={(dustAmount) => setEffects({ dustAmount })} format={pct} />
          </SubControls>
        )}
        <Toggle label="Light on keys" hint="Colored light spills onto played keys" checked={fx.keyLight} onChange={(keyLight) => setEffects({ keyLight })} />
        {fx.keyLight && (
          <SubControls>
            <Slider label="Key light" min={0.05} max={1} value={fx.keyLightIntensity} onChange={(keyLightIntensity) => setEffects({ keyLightIntensity })} format={pct} />
          </SubControls>
        )}
        <Slider label="Outline glow" min={0} max={1} value={fx.outlineGlow} onChange={(outlineGlow) => setEffects({ outlineGlow })} format={(x) => (x <= 0 ? 'Off' : pct(x))} />
        <Toggle label="Light trails" checked={v.trails} onChange={(trails) => setVisual({ trails })} />
        <Toggle label="Sparks on key hits" checked={v.particles} onChange={(particles) => setVisual({ particles })} />
      </Section>

      <Section title="Keyboard">
        <Toggle label="Show keyboard" checked={v.showKeyboard} onChange={(showKeyboard) => setVisual({ showKeyboard })} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-100">Keyboard style</span>
          <Segmented
            size="sm"
            ariaLabel="Keyboard style"
            value={v.keyboardStyle}
            onChange={(keyboardStyle) => setVisual({ keyboardStyle })}
            options={[
              { value: 'flat', label: 'Flat', title: 'Clean drawn keys' },
              { value: 'realistic', label: 'Realistic', title: 'Shaded keys with gloss and reflections' },
            ]}
          />
        </div>
        <Select<KeyboardRange>
          label="Range"
          value={v.range}
          onChange={(range) => setVisual({ range })}
          options={[
            { value: 'full', label: '88 keys (full piano)' },
            { value: '76', label: '76 keys' },
            { value: '61', label: '61 keys' },
            { value: '49', label: '49 keys' },
            { value: 'auto', label: 'Fit to song' },
          ]}
        />
        <Slider label="Keyboard height" min={0.08} max={0.3} value={v.keyboardHeight} onChange={(keyboardHeight) => setVisual({ keyboardHeight })} format={pct} />
        <Segmented
          size="sm"
          value={v.keyboardTheme}
          onChange={(keyboardTheme) => {
            if (keyboardTheme === 'custom') setVisual({ keyboardTheme });
            else {
              const k = KEYBOARD_THEMES[keyboardTheme];
              setVisual({ keyboardTheme, whiteKeyColor: k.white, blackKeyColor: k.black, keyBorderColor: k.border });
            }
          }}
          options={[
            { value: 'classic', label: 'Classic' },
            { value: 'ivory', label: 'Ivory' },
            { value: 'dark', label: 'Dark' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {v.keyboardTheme === 'custom' && (
          <>
            <ColorInput label="White keys" value={v.whiteKeyColor} onChange={(whiteKeyColor) => setVisual({ whiteKeyColor })} />
            <ColorInput label="Black keys" value={v.blackKeyColor} onChange={(blackKeyColor) => setVisual({ blackKeyColor })} />
            <ColorInput label="Key borders" value={v.keyBorderColor} onChange={(keyBorderColor) => setVisual({ keyBorderColor })} />
          </>
        )}
        <Toggle label="Custom key highlight color" checked={v.keyHighlight === 'custom'} onChange={(on) => setVisual({ keyHighlight: on ? 'custom' : 'hand' })} />
        {v.keyHighlight === 'custom' && <ColorInput label="Highlight" value={v.keyHighlightColor} onChange={(keyHighlightColor) => setVisual({ keyHighlightColor })} />}
      </Section>

      <Section title="Guides">
        <Segmented
          size="sm"
          value={v.guides}
          onChange={(guides) => setVisual({ guides })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'octaves', label: 'Octaves' },
            { value: 'all', label: 'Key lanes' },
          ]}
        />
        <Toggle label="Beat & bar lines" checked={v.beatLines} onChange={(beatLines) => setVisual({ beatLines })} />
        <Toggle label="Sustain pedal lane" checked={v.showPedal} onChange={(showPedal) => setVisual({ showPedal })} />
        <Toggle label="Hit line glow" checked={v.hitLine} onChange={(hitLine) => setVisual({ hitLine })} />
      </Section>

      <Section title="Background">
        <Segmented
          size="sm"
          value={bg.kind}
          onChange={(kind) => setBackground({ kind, mediaId: kind === bg.kind ? bg.mediaId : null })}
          options={[
            { value: 'preset', label: 'Scene' },
            { value: 'color', label: 'Color' },
            { value: 'image', label: 'Image' },
            { value: 'video', label: 'Video' },
          ]}
        />
        {bg.kind === 'preset' && (
          <div className="grid grid-cols-3 gap-2">
            {BACKGROUND_PRESETS.map((p) => (
              <PresetThumb key={p.id} id={p.id} name={p.name} active={bg.presetId === p.id} onClick={() => setBackground({ presetId: p.id })} />
            ))}
          </div>
        )}
        {bg.kind === 'color' && <ColorInput label="Color" value={bg.color} onChange={(color) => setBackground({ color })} />}
        {(bg.kind === 'image' || bg.kind === 'video') && (
          <MediaPicker kind={bg.kind} purpose="background" what="background" selectedId={bg.mediaId} onSelect={(mediaId) => setBackground({ mediaId })} />
        )}
        <Slider label="Brightness" min={0.2} max={1.6} value={bg.brightness} onChange={(brightness) => setBackground({ brightness })} format={pct} />
        {(bg.kind === 'image' || bg.kind === 'video') && (
          <>
            <Slider label="Blur" min={0} max={30} step={1} value={bg.blur} onChange={(blur) => setBackground({ blur })} format={(x) => `${x}px`} />
            <Slider label="Contrast" min={0.4} max={1.6} value={bg.contrast} onChange={(contrast) => setBackground({ contrast })} format={pct} />
            <Slider label="Visibility" min={0.05} max={1} value={bg.opacity} onChange={(opacity) => setBackground({ opacity })} format={pct} />
            <ColorInput label="Overlay color" value={bg.overlayColor} onChange={(overlayColor) => setBackground({ overlayColor })} />
            <Slider label="Overlay strength" min={0} max={0.9} value={bg.overlayOpacity} onChange={(overlayOpacity) => setBackground({ overlayOpacity })} format={pct} />
            <Segmented
              size="sm"
              value={bg.fit}
              onChange={(fit) => setBackground({ fit })}
              options={[
                { value: 'cover', label: 'Fill' },
                { value: 'contain', label: 'Fit' },
              ]}
            />
            <Slider label="Zoom" min={1} max={3} value={bg.scale} onChange={(scale) => setBackground({ scale })} format={(x) => `${x.toFixed(2)}×`} />
            <Slider label="Horizontal position" min={0} max={1} value={bg.posX} onChange={(posX) => setBackground({ posX })} format={pct} />
            <Slider label="Vertical position" min={0} max={1} value={bg.posY} onChange={(posY) => setBackground({ posY })} format={pct} />
          </>
        )}
      </Section>
    </div>
  );
}
