import { useTransport } from '../../state/transportStore';

/**
 * Practice score on the stage itself (the side panel may be closed, or the view full screen):
 * "Pass 3 · 82% (best 91%)". A new pass starts at every loop wrap or jump back.
 */
export function PracticeBadge() {
  const active = useTransport((s) => s.practiceActive);
  const stats = useTransport((s) => s.stats);
  if (!active || !stats) return null;
  const started = stats.total + stats.wrong > 0;
  return (
    <div
      data-practice-badge
      role="status"
      aria-live="off"
      className="pointer-events-none absolute left-2 z-10 rounded-full bg-black/70 px-3 py-1.5 text-[13px] font-medium text-white tabular-nums ring-1 ring-white/15 backdrop-blur-md"
      style={{ top: 'calc(var(--fs-top, 0px) + 0.5rem)' }}
    >
      Pass {stats.pass} · {started ? `${stats.accuracy}%` : '–'}
      {stats.bestAccuracy !== null && <span className="text-ink-300"> (best {stats.bestAccuracy}%)</span>}
    </div>
  );
}
