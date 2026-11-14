/**
 * Drawn over the sheet in Edit mode (never into the music): the ghost note of Add mode or of a
 * drag, with ledger lines and a pitch bubble, and the selection box. Pointer events pass through.
 */
import { useSheetOverlay } from './useSheetPointer';

export function SheetEditOverlay() {
  const ghost = useSheetOverlay((s) => s.ghost);
  const marquee = useSheetOverlay((s) => s.marquee);
  const ring = useSheetOverlay((s) => s.ring);
  const sel = useSheetOverlay((s) => s.sel);
  if (!ghost && !marquee && !ring && !sel.length) return null;
  const ledgers: number[] = [];
  if (ghost && ghost.gap) {
    // steps above the top line (2 per line) or below the bottom line (-8)
    for (let k = 2; k <= ghost.steps; k += 2) ledgers.push(ghost.staffTop - (k / 2) * ghost.gap);
    for (let k = -10; k >= ghost.steps; k -= 2) ledgers.push(ghost.staffTop - (k / 2) * ghost.gap);
  }
  const g = ghost?.gap || 10;
  return (
    <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible" aria-hidden data-testid="sheet-overlay">
      {sel.length > 0 && (
        <g data-testid="sheet-sel-rings">
          {sel.map((b, i) => {
            const pad = Math.max(3, b.h * 0.35);
            return <rect key={i} x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad} rx={(b.h + 2 * pad) / 2} className="sheet-sel-ring" />;
          })}
        </g>
      )}
      {ghost && (
        <g data-testid="sheet-ghost">
          {ledgers.map((y) => (
            <line key={y} x1={ghost.x - g * 1.1} x2={ghost.x + g * 1.1} y1={y} y2={y} className="stroke-accent-500" strokeWidth={1.2} opacity={0.8} />
          ))}
          <ellipse cx={ghost.x} cy={ghost.y} rx={g * 0.62} ry={g * 0.45} transform={`rotate(-20 ${ghost.x} ${ghost.y})`} className="fill-accent-500/70" />
          <g transform={`translate(${ghost.x + g * 1.2}, ${ghost.y - g * 2.6})`}>
            <rect x={0} y={-11} rx={6} width={ghost.label.length * 6.4 + 14} height={20} className="fill-ink-900/90" />
            <text x={7} y={3} className="fill-white font-mono" fontSize={11.5}>
              {ghost.label}
            </text>
          </g>
        </g>
      )}
      {ring && (
        <rect
          x={ring.x0}
          y={ring.y0}
          width={ring.x1 - ring.x0}
          height={ring.y1 - ring.y0}
          rx={5}
          className="fill-accent-500/15 stroke-accent-500"
          strokeWidth={1.5}
          data-testid="sheet-mark-ring"
        />
      )}
      {marquee && (
        <rect
          x={Math.min(marquee.x0, marquee.x1)}
          y={Math.min(marquee.y0, marquee.y1)}
          width={Math.abs(marquee.x1 - marquee.x0)}
          height={Math.abs(marquee.y1 - marquee.y0)}
          className="fill-accent-500/10 stroke-accent-500"
          strokeDasharray="4 3"
          data-testid="sheet-marquee"
        />
      )}
    </svg>
  );
}
