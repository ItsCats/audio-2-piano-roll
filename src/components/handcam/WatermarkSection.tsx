/**
 * "Watermark" section of the Export video dialog: your channel link (text) and an optional logo, saved
 * as your default for every export.
 */
import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { Button, ColorInput, Select, Slider, Toggle, cn } from '../ui';
import { useWatermark } from '../../state/watermarkStore';
import { WATERMARK_PLACEHOLDER, type WatermarkPosition } from '../../lib/watermark/types';
import type { FontKey } from '../../lib/render/titleCard/presets';
import { removeLogo, storeLogo } from '../../lib/watermark/logo';
import { useLogo } from './hooks';

const FONT_NAMES: Record<FontKey, string> = {
  cormorant: 'Cormorant (elegant serif)',
  cinzel: 'Cinzel (classic capitals)',
  playfair: 'Playfair Display',
  garamond: 'EB Garamond',
  vibes: 'Great Vibes (script)',
  inter: 'Inter (clean sans)',
};

const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: 'bc', label: 'Bottom center' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' },
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
];

function Chips({ value, onChange, label }: { value: WatermarkPosition; onChange: (v: WatermarkPosition) => void; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12.5px] text-ink-200">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {POSITIONS.map((p) => (
          <button
            key={p.value}
            role="radio"
            aria-checked={value === p.value}
            onClick={() => onChange(p.value)}
            className={cn('focus-ring rounded-full border px-2.5 py-1 text-[12px]', value === p.value ? 'border-accent-400 bg-accent-500/15 text-ink-50' : 'border-ink-600 text-ink-200 hover:border-ink-400')}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function WatermarkSection() {
  const w = useWatermark();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logo = useLogo(w.logo?.mediaId);
  const logoUrl = logo ? bitmapUrl(logo) : null;

  const addLogo = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const id = await storeLogo(file);
      const old = w.logo?.mediaId;
      w.setLogo(w.logo ? { mediaId: id } : { mediaId: id, position: w.position === 'br' ? 'bl' : 'br' });
      if (!w.enabled) w.set({ enabled: true });
      if (old) void removeLogo(old);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t read this image. Choose a PNG or SVG.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-b border-ink-700 p-4" data-testid="watermark-section">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">Watermark</span>
      <Toggle label="Add your watermark" hint="Your channel link or name, saved for every export" checked={w.enabled} onChange={(enabled) => w.set({ enabled })} />
      {w.enabled && (
        <>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12.5px] text-ink-200">Text</span>
            <input
              className="focus-ring h-9 w-full min-w-0 rounded-[10px] border border-ink-600 bg-ink-800 px-2.5 text-[13px] text-ink-50 placeholder:text-ink-500"
              value={w.text}
              placeholder={WATERMARK_PLACEHOLDER}
              maxLength={80}
              aria-label="Watermark text"
              onChange={(e) => w.set({ text: e.target.value })}
            />
          </label>
          {!w.text.trim() && !w.logo && (
            <p className="text-[12px] text-warn" data-testid="watermark-empty">
              Type your text (for example your channel link) or add a logo. Nothing is shown until you do.
            </p>
          )}
          <Toggle label="Spaced capitals" checked={w.spaced} onChange={(spaced) => w.set({ spaced })} />
          <Toggle label="Highlight your name" hint="The part after the last / is brighter" checked={w.highlightName} onChange={(highlightName) => w.set({ highlightName })} />
          <Select<FontKey> label="Font" value={w.font} onChange={(font) => w.set({ font })} options={(Object.keys(FONT_NAMES) as FontKey[]).map((f) => ({ value: f, label: FONT_NAMES[f] }))} />
          <Slider label="Size" min={0.5} max={3} step={0.05} value={w.size} onChange={(size) => w.set({ size })} format={(x) => `${Math.round(x * 100)}%`} />
          <ColorInput label="Color" value={w.color} onChange={(color) => w.set({ color })} />
          <Slider label="Opacity" min={0.05} max={1} step={0.05} value={w.opacity} onChange={(opacity) => w.set({ opacity })} format={(x) => `${Math.round(x * 100)}%`} />
          <Chips label="Position" value={w.position} onChange={(position) => w.set({ position })} />
          <Toggle label="Also on the title page and end card" checked={w.onCards} onChange={(onCards) => w.set({ onCards })} />

          <div className="flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3">
            <span className="text-[12.5px] text-ink-200">Logo (optional)</span>
            <input
              ref={input}
              type="file"
              accept="image/png,image/svg+xml,image/webp,.png,.svg,.webp"
              className="hidden"
              aria-label="Logo image"
              data-testid="watermark-logo-input"
              onChange={(e) => {
                void addLogo(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="flex items-center gap-2">
              {logoUrl && <img src={logoUrl} alt="Your logo" className="h-10 w-10 rounded bg-[repeating-conic-gradient(#2a2a33_0_25%,#1a1a20_0_50%)] bg-[length:8px_8px] object-contain" />}
              <Button size="sm" icon={busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />} disabled={busy} onClick={() => input.current?.click()}>
                {w.logo ? 'Change logo' : 'Add logo'}
              </Button>
              {w.logo && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={14} />}
                  onClick={() => {
                    const id = w.logo!.mediaId;
                    w.setLogo(null);
                    void removeLogo(id);
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
            {!w.logo && <p className="text-[11.5px] text-ink-400">A PNG or SVG with a transparent background works best.</p>}
            {w.logo && (
              <>
                <Chips label="Logo position" value={w.logo.position} onChange={(position) => w.setLogo({ position })} />
                <Slider label="Logo size" min={0.03} max={0.25} step={0.005} value={w.logo.size} onChange={(size) => w.setLogo({ size })} format={(x) => `${Math.round(x * 100)}% of the height`} />
                <Slider label="Logo opacity" min={0.05} max={1} step={0.05} value={w.logo.opacity} onChange={(opacity) => w.setLogo({ opacity })} format={(x) => `${Math.round(x * 100)}%`} />
              </>
            )}
            {error && <p className="text-[12px] text-bad">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}

const urlCache = new WeakMap<ImageBitmap, string>();
function bitmapUrl(b: ImageBitmap): string | null {
  const hit = urlCache.get(b);
  if (hit) return hit;
  try {
    const c = document.createElement('canvas');
    c.width = b.width;
    c.height = b.height;
    c.getContext('2d')!.drawImage(b, 0, 0);
    const url = c.toDataURL('image/png');
    urlCache.set(b, url);
    return url;
  } catch {
    return null;
  }
}
