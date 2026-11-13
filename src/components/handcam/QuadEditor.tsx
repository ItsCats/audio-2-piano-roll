import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { drawOriented, type FrameImage, type Orient } from './hooks';
import { FrameCanvas } from './FrameCanvas';

const LOUPE = 104;
const Z = 3;

/** the picture around one point, magnified (drawn from the frame itself: nothing encoded) */
function Loupe({ image, orient, w, h, px, py }: { image: FrameImage; orient?: Orient | null; w: number; h: number; px: number; py: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.round(LOUPE * dpr);
    if (c.width !== s) c.width = c.height = s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    drawOriented(ctx, image.canvas, orient, LOUPE / 2 - px * Z, LOUPE / 2 - py * Z, w * Z, h * Z);
  }, [image, orient, w, h, px, py]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

/** Four draggable corners (fractions 0..1 of the picture) over an image, with a magnifier while dragging. */
export function QuadEditor({
  image,
  orient,
  aspect,
  corners,
  labels,
  onChange,
  maxHeight = '52vh',
}: {
  /** the frame, as decoded */
  image: FrameImage;
  /** how it is shown (Turn 180°, Mirror) */
  orient?: Orient | null;
  /** width ÷ height of the picture */
  aspect: number;
  corners: [number, number][];
  labels: string[];
  onChange: (c: [number, number][]) => void;
  maxHeight?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ i: number; id: number; dx: number; dy: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [said, setSaid] = useState('');
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const toFrac = (cx: number, cy: number): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [clamp((cx - r.left) / r.width), clamp((cy - r.top) / r.height)];
  };
  const onDown = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = toFrac(e.clientX, e.clientY);
    drag.current = { i, id: e.pointerId, dx: corners[i][0] - x, dy: corners[i][1] - y };
    setActive(i);
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const [x, y] = toFrac(e.clientX, e.clientY);
    const next = corners.map((c) => [c[0], c[1]] as [number, number]);
    next[d.i] = [clamp(x + d.dx), clamp(y + d.dy)];
    onChange(next);
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setActive(null);
  };
  const where = (c: [number, number]) => `${Math.round(c[0] * 100)}% from the left, ${Math.round(c[1] * 100)}% from the top`;
  const onKey = (i: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 0.02 : 0.003;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const next = corners.map((c) => [c[0], c[1]] as [number, number]);
    next[i] = [clamp(next[i][0] + d[0]), clamp(next[i][1] + d[1])];
    onChange(next);
    setSaid(`${labels[i]}: ${where(next[i])}`);
  };
  const pts = corners.map((c) => `${c[0] * 1000},${c[1] * 1000}`).join(' ');
  let loupe = null;
  if (active !== null && size.w) {
    const px = corners[active][0] * size.w;
    const py = corners[active][1] * size.h;
    const above = py > LOUPE + 30;
    loupe = (
      <div
        aria-hidden
        className="pointer-events-none absolute z-20 overflow-hidden rounded-full border-2 border-white shadow-xl"
        style={{
          left: Math.max(0, Math.min(size.w - LOUPE, px - LOUPE / 2)),
          top: above ? py - LOUPE - 28 : py + 28,
          width: LOUPE,
          height: LOUPE,
        }}
      >
        <Loupe image={image} orient={orient} w={size.w} h={size.h} px={px} py={py} />
        <span className="absolute top-1/2 left-0 h-px w-full bg-accent-400" />
        <span className="absolute top-0 left-1/2 h-full w-px bg-accent-400" />
      </div>
    );
  }
  return (
    <div className="flex justify-center px-4 select-none sm:px-1" data-testid="quad-editor">
      <div ref={box} className="relative w-full" style={{ aspectRatio: String(aspect), maxHeight, maxWidth: `calc(${maxHeight} * ${aspect})` }}>
        <FrameCanvas img={image} orient={orient} className="absolute inset-0 block h-full w-full rounded-md" label="A frame from your video" />
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
          <path d={`M0,0H1000V1000H0Z M${corners.map((c) => `${c[0] * 1000},${c[1] * 1000}`).join(' L')} Z`} fill="rgba(0,0,0,0.4)" fillRule="evenodd" />
          <polygon points={pts} fill="none" stroke="var(--color-accent-400, #8aa2ff)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {/* the back edge (where notes land) brighter */}
          <line x1={corners[0][0] * 1000} y1={corners[0][1] * 1000} x2={corners[1][0] * 1000} y2={corners[1][1] * 1000} stroke="#fff" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        </svg>
        {corners.map((c, i) => (
          <button
            key={i}
            type="button"
            data-corner={i}
            aria-label={`${labels[i]}, ${where(c)}. Use the arrow keys to move it.`}
            onPointerDown={onDown(i)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey(i)}
            className="focus-ring absolute z-10 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full active:cursor-grabbing"
            style={{ left: `${c[0] * 100}%`, top: `${c[1] * 100}%`, touchAction: 'none' }}
          >
            <span className={`flex items-center justify-center rounded-full border-2 border-white bg-accent-500 text-[9px] font-bold text-white shadow-[0_0_0_2px_rgba(0,0,0,0.35)] ${active === i ? 'h-6 w-6' : 'h-5 w-5'}`}>{i + 1}</span>
          </button>
        ))}
        {loupe}
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
