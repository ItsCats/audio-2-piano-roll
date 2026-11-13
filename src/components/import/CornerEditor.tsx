import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Camera, RotateCcw } from 'lucide-react';
import { Button } from '../ui';

/** Page corners in image pixels: top-left, top-right, bottom-right, bottom-left. */
export type Corners = [number, number][];

const NAMES = ['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner'];
/** loupe size and zoom while a corner is dragged */
const LOUPE = 112;
const ZOOM = 2.5;

/** The whole image as corners. */
export function fullCorners(w: number, h: number): Corners {
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

/**
 * Four draggable page corners over a photo (mouse, touch and keyboard: arrow keys move the focused
 * corner). Large hit targets; a magnifier shows the spot under the finger while dragging.
 * `preview` is the photo (any size) whose full-resolution size is `width` × `height`; corners are in
 * those full-resolution pixels.
 */
export function CornerEditor({
  preview,
  width,
  height,
  corners,
  onChange,
  onDone,
  onRetake,
  onReset,
  retakeLabel = 'Retake',
  label,
}: {
  preview: string;
  width: number;
  height: number;
  corners: Corners;
  onChange: (c: Corners) => void;
  onDone: () => void;
  onRetake: () => void;
  onReset?: () => void;
  retakeLabel?: string;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; id: number; dx: number; dy: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** read out after a keyboard move (screen readers) */
  const [said, setSaid] = useState('');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    root.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    // each photo's corner screen takes the focus (after "Looks good" it would otherwise drop to the page)
    root.current?.focus({ preventScroll: true });
  }, []);

  const toImage = (clientX: number, clientY: number): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * width;
    const y = ((clientY - r.top) / r.height) * height;
    return [Math.max(0, Math.min(width, x)), Math.max(0, Math.min(height, y))];
  };

  const onDown = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = toImage(e.clientX, e.clientY);
    // keep the finger's offset from the corner: the corner does not jump under the finger
    drag.current = { i, id: e.pointerId, dx: corners[i][0] - x, dy: corners[i][1] - y };
    setActive(i);
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const [x, y] = toImage(e.clientX, e.clientY);
    const next = corners.map((c) => [c[0], c[1]] as [number, number]);
    next[d.i] = [Math.max(0, Math.min(width, x + d.dx)), Math.max(0, Math.min(height, y + d.dy))];
    onChange(next);
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setActive(null);
  };
  const onKey = (i: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = (e.shiftKey ? 0.025 : 0.005) * Math.max(width, height);
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const next = corners.map((c) => [c[0], c[1]] as [number, number]);
    next[i] = [Math.max(0, Math.min(width, next[i][0] + d[0])), Math.max(0, Math.min(height, next[i][1] + d[1]))];
    onChange(next);
    setSaid(`${NAMES[i]}: ${where(next[i])}`);
  };
  /** "12% from the left, 5% from the top" */
  const where = (c: [number, number]) => `${Math.round((c[0] / width) * 100)}% from the left, ${Math.round((c[1] / height) * 100)}% from the top`;

  const pct = (c: [number, number]) => ({ left: `${(c[0] / width) * 100}%`, top: `${(c[1] / height) * 100}%` });
  const poly = corners.map((c) => `${c[0]},${c[1]}`).join(' ');
  const shade = `M0,0H${width}V${height}H0Z M${corners.map((c) => `${c[0]},${c[1]}`).join(' L')} Z`;

  // magnifier: above the finger (below it near the top edge), showing the corner's spot enlarged
  const loupe = (() => {
    if (active === null || !size.w) return null;
    const [cx, cy] = corners[active];
    const px = (cx / width) * size.w;
    const py = (cy / height) * size.h;
    const above = py > LOUPE + 40;
    const left = Math.max(0, Math.min(size.w - LOUPE, px - LOUPE / 2));
    const top = above ? py - LOUPE - 36 : py + 36;
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute z-20 overflow-hidden rounded-full border-2 border-white shadow-xl"
        style={{
          left,
          top,
          width: LOUPE,
          height: LOUPE,
          backgroundImage: `url(${preview})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${size.w * ZOOM}px ${size.h * ZOOM}px`,
          backgroundPosition: `${LOUPE / 2 - px * ZOOM}px ${LOUPE / 2 - py * ZOOM}px`,
        }}
      >
        <span className="absolute top-1/2 left-0 h-px w-full bg-accent-400" />
        <span className="absolute top-0 left-1/2 h-full w-px bg-accent-400" />
      </div>
    );
  })();

  return (
    <div ref={root} tabIndex={-1} aria-labelledby="corner-editor-title" className="flex flex-col gap-3 outline-none" data-testid="corner-editor">
      <div>
        <p id="corner-editor-title" className="text-[14px] font-medium text-ink-50">
          {label ?? 'Adjust the corners'}
        </p>
        <p className="text-[12.5px] text-ink-300">Drag the four dots onto the corners of the page, so only the music is inside.</p>
        <p className="mt-0.5 text-[12px] text-ink-400">Lay the page flat and keep the photo sharp: curved pages and blurry photos come out wrong, even with the corners set.</p>
      </div>
      {/* side padding on phones: a dot at the photo's edge stays clear of the screen edge (the browser's back swipe) */}
      <div className="flex justify-center rounded-xl bg-black/40 px-5 py-2 select-none sm:px-2">
        <div ref={box} className="relative inline-block max-w-full">
          <img src={preview} alt="Your photo" draggable={false} className="block max-h-[58vh] max-w-full" />
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
            <path d={shade} fill="rgba(0,0,0,0.45)" fillRule="evenodd" />
            <polygon points={poly} fill="none" stroke="var(--color-accent-400, #8aa2ff)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          </svg>
          {corners.map((c, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${NAMES[i]}, ${where(c)}. Use the arrow keys to move it.`}
              data-corner={i}
              onPointerDown={onDown(i)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={onKey(i)}
              className="focus-ring absolute z-10 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full active:cursor-grabbing"
              style={{ ...pct(c), touchAction: 'none' }}
            >
              <span className={`block rounded-full border-2 border-white bg-accent-500 shadow-[0_0_0_2px_rgba(0,0,0,0.35)] transition-transform ${active === i ? 'h-6 w-6' : 'h-5 w-5'}`} />
            </button>
          ))}
          {loupe}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Check size={16} />} onClick={onDone}>
          Looks good
        </Button>
        <Button icon={<Camera size={15} />} onClick={onRetake}>
          {retakeLabel}
        </Button>
        {onReset && (
          <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={onReset}>
            Whole photo
          </Button>
        )}
      </div>
    </div>
  );
}
