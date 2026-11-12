import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { TitleCardCache, drawTitleCard } from '../../lib/render/titleCard/draw';
import type { CardImages } from '../../lib/render/titleCard/background';
import type { LayoutOptions } from '../../lib/render/titleCard/layout';
import type { ResolvedLook } from '../../lib/render/titleCard/presets';
import { endOpacity } from '../../lib/render/titleCard/timeline';
import type { TitleText } from '../../lib/render/titleCard/types';
import { cn } from '../ui';

/** Longest preview edge in canvas pixels (the export draws the same layout at full size). */
const PREVIEW_EDGE = 640;

/**
 * Live canvas preview of a title page / end card at the output's aspect ratio. Shows the finished
 * card; Play runs the animation once. Re-renders at most once per animation frame while typing.
 */
export function TitleCardPreview({
  look,
  text,
  width,
  height,
  duration,
  images,
  fontsVersion,
  layout,
  end,
  label,
  className,
}: {
  look: ResolvedLook;
  text: TitleText;
  width: number;
  height: number;
  duration: number;
  images: CardImages;
  fontsVersion: number;
  layout?: LayoutOptions;
  /** end card: fades in and out of black */
  end?: boolean;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cache = useMemo(() => new TitleCardCache(), []);
  useEffect(() => () => cache.dispose(), [cache]);
  const s = Math.min(1, PREVIEW_EDGE / Math.max(width, height));
  const W = Math.max(2, Math.round(width * s));
  const H = Math.max(2, Math.round(height * s));
  const [t, setT] = useState<number | null>(null); // null = finished card
  const playing = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // draw (coalesced to one render per frame)
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const id = requestAnimationFrame(() => {
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const time = t ?? Math.max(0, duration - 1);
      drawTitleCard(ctx, W, H, look, text, images, time, cache, { duration, reveal: t === null, layout });
      if (end && t !== null) {
        const op = endOpacity(time, duration);
        if (op < 1) {
          ctx.fillStyle = `rgba(0,0,0,${1 - op})`;
          ctx.fillRect(0, 0, W, H);
        }
      }
    });
    return () => cancelAnimationFrame(id);
  }, [look, text, images, W, H, t, duration, cache, fontsVersion, layout, end]);

  const stop = () => {
    playing.current = false;
    setIsPlaying(false);
    setT(null);
  };
  useEffect(() => () => void (playing.current = false), []);

  const play = () => {
    if (playing.current) return stop();
    playing.current = true;
    setIsPlaying(true);
    const t0 = performance.now();
    const step = () => {
      if (!playing.current) return;
      const x = (performance.now() - t0) / 1000;
      if (x >= duration) return stop();
      setT(x);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-center rounded-xl bg-[repeating-conic-gradient(#15151b_0_25%,#101014_0_50%)] bg-[length:20px_20px] p-2">
        <canvas
          ref={ref}
          role="img"
          aria-label={label}
          className="block max-h-[260px] max-w-full rounded-md shadow-xl ring-1 ring-white/10 lg:max-h-[220px]"
          style={{ aspectRatio: `${width} / ${height}` }}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={play}
          className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800 px-2.5 text-[12.5px] text-ink-100 hover:bg-ink-700"
          aria-label={isPlaying ? 'Stop the preview' : 'Play the preview'}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />} {isPlaying ? 'Stop' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={t ?? Math.max(0, duration - 1)}
          aria-label="Preview time"
          className="min-w-0 flex-1"
          style={{ ['--fill' as string]: `${((t ?? Math.max(0, duration - 1)) / duration) * 100}%` }}
          onChange={(e) => {
            playing.current = false;
            setIsPlaying(false);
            setT(parseFloat(e.target.value));
          }}
        />
      </div>
    </div>
  );
}
