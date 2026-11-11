import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2, RotateCcw } from 'lucide-react';
import { useSettings } from '../../../state/settingsStore';
import { BACKGROUND_PRESETS } from '../../../lib/render/backgrounds';
import { KEYBOARD_THEMES, VISUAL_THEMES, applyTheme, type KeyboardRange } from '../../../lib/render/settings';
import { Button, ColorInput, Section, Segmented, Select, Slider, Toggle, cn } from '../../ui';
import { deleteMedia, listMedia, newId, saveMedia, type MediaItem } from '../../../lib/storage/db';
import { toast } from '../../../state/toastStore';

const MAX_MEDIA = 200 * 1024 * 1024;

function PresetThumb({ id, active, onClick, name }: { id: string; active: boolean; onClick: () => void; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = 96;
    c.height = 54;
    const p = BACKGROUND_PRESETS.find((b) => b.id === id);
    if (p) p.draw(c.getContext('2d')!, 96, 54);
  }, [id]);
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

function MediaPicker() {
  const bg = useSettings((s) => s.visual.background);
  const setBackground = useSettings((s) => s.setBackground);
  const [items, setItems] = useState<MediaItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => void listMedia().then(setItems);
  useEffect(refresh, []);
  const onFile = async (f: File) => {
    const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
    if (!kind || !/^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm|quicktime))$/.test(f.type)) {
      toast.error('Unsupported background', 'Use JPG, PNG, WEBP images or MP4/WebM videos.');
      return;
    }
    if (f.size > MAX_MEDIA) {
      toast.error('File too large', 'Backgrounds are limited to 200 MB.');
      return;
    }
    const item: MediaItem = { id: newId(), name: f.name, type: f.type, kind, blob: f, createdAt: Date.now() };
    try {
      await saveMedia(item);
      setBackground({ kind, mediaId: item.id });
      refresh();
    } catch (e) {
      toast.error('Could not store background', (e as Error).message);
    }
  };
  const list = items.filter((i) => i.kind === bg.kind);
  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" variant="subtle" icon={<ImagePlus size={15} />} onClick={() => input.current?.click()}>
        Upload {bg.kind === 'video' ? 'video (MP4/WebM)' : 'image (JPG/PNG/WEBP)'}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept={bg.kind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp'}
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
                bg.mediaId === m.id ? 'bg-accent-500/15 text-ink-50' : 'text-ink-200 hover:bg-ink-800',
              )}
            >
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => setBackground({ mediaId: m.id })}>
                {m.name}
              </button>
              <button
                className="text-ink-400 hover:text-bad"
                aria-label={`Delete ${m.name}`}
                onClick={async () => {
                  await deleteMedia(m.id);
                  if (bg.mediaId === m.id) setBackground({ mediaId: null });
                  refresh();
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LookPanel() {
  const v = useSettings((s) => s.visual);
  const setVisual = useSettings((s) => s.setVisual);
  const replaceVisual = useSettings((s) => s.replaceVisual);
  const setBackground = useSettings((s) => s.setBackground);
  const resetVisual = useSettings((s) => s.resetVisual);
  const bg = v.background;
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
                <span className="flex gap-0.5">
                  <span className="h-4 w-1.5 rounded-sm" style={{ background: c1 }} />
                  <span className="h-4 w-1.5 rounded-sm" style={{ background: c2 }} />
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
        {v.colorMode === 'single' && <ColorInput label="Note colour" value={v.singleColor} onChange={(singleColor) => setVisual({ singleColor })} />}
        <Slider label="Note speed (seconds visible)" min={0.8} max={10} step={0.1} value={v.lookahead} onChange={(lookahead) => setVisual({ lookahead })} format={(x) => `${x.toFixed(1)}s`} />
        <Slider label="Note width" min={0.4} max={1} value={v.noteWidth} onChange={(noteWidth) => setVisual({ noteWidth })} format={pct} />
        <Slider label="Opacity" min={0.2} max={1} value={v.noteOpacity} onChange={(noteOpacity) => setVisual({ noteOpacity })} format={pct} />
        <Slider label="Corner radius" min={0} max={14} step={1} value={v.cornerRadius} onChange={(cornerRadius) => setVisual({ cornerRadius })} format={(x) => `${x}px`} />
        <Slider label="Glow" min={0} max={1} value={v.glow} onChange={(glow) => setVisual({ glow })} format={pct} />
        <Slider label="Border" min={0} max={3} step={0.5} value={v.borderWidth} onChange={(borderWidth) => setVisual({ borderWidth })} format={(x) => `${x}px`} />
        {v.borderWidth > 0 && <ColorInput label="Border colour" value={v.borderColor} onChange={(borderColor) => setVisual({ borderColor })} />}
        <Toggle label="Gradient fill" checked={v.gradient} onChange={(gradient) => setVisual({ gradient })} />
        <Toggle label="Drop shadow" checked={v.shadow} onChange={(shadow) => setVisual({ shadow })} />
        <Toggle label="Light trails" checked={v.trails} onChange={(trails) => setVisual({ trails })} />
        <Toggle label="Sparks on key hits" checked={v.particles} onChange={(particles) => setVisual({ particles })} />
        <Toggle label="Highlight upcoming notes" checked={v.upcomingHighlight} onChange={(upcomingHighlight) => setVisual({ upcomingHighlight })} />
      </Section>

      <Section title="Keyboard">
        <Toggle label="Show keyboard" checked={v.showKeyboard} onChange={(showKeyboard) => setVisual({ showKeyboard })} />
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
        <Toggle label="Custom key highlight colour" checked={v.keyHighlight === 'custom'} onChange={(on) => setVisual({ keyHighlight: on ? 'custom' : 'hand' })} />
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
            { value: 'color', label: 'Colour' },
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
        {bg.kind === 'color' && <ColorInput label="Colour" value={bg.color} onChange={(color) => setBackground({ color })} />}
        {(bg.kind === 'image' || bg.kind === 'video') && <MediaPicker />}
        <Slider label="Brightness" min={0.2} max={1.6} value={bg.brightness} onChange={(brightness) => setBackground({ brightness })} format={pct} />
        {(bg.kind === 'image' || bg.kind === 'video') && (
          <>
            <Slider label="Blur" min={0} max={30} step={1} value={bg.blur} onChange={(blur) => setBackground({ blur })} format={(x) => `${x}px`} />
            <Slider label="Contrast" min={0.4} max={1.6} value={bg.contrast} onChange={(contrast) => setBackground({ contrast })} format={pct} />
            <Slider label="Visibility" min={0.05} max={1} value={bg.opacity} onChange={(opacity) => setBackground({ opacity })} format={pct} />
            <ColorInput label="Overlay colour" value={bg.overlayColor} onChange={(overlayColor) => setBackground({ overlayColor })} />
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
