/** A button of the sheet's edit bar (36 px on a computer, 48 px in the phone dock), and a separator. */
import type { ReactNode } from 'react';
import { cn } from '../../ui';

export function Tool({
  label,
  title,
  onClick,
  disabled,
  active,
  dock,
  children,
  testId,
  wide,
  why,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is off, added to the tooltip while disabled (default: a note must be selected). */
  why?: string;
  active?: boolean;
  dock: boolean;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  return (
    // aria-disabled (not disabled): the tooltip still shows on hover and says why it is off
    <button
      type="button"
      aria-label={label}
      title={disabled ? `${title ?? label}. ${why ?? 'Select a note first.'}` : (title ?? label)}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      onClick={() => !disabled && onClick()}
      // keep the keyboard focus on the sheet: shortcuts keep working after a click
      onPointerDown={(e) => e.pointerType === 'mouse' && e.preventDefault()}
      className={cn(
        'focus-ring inline-flex shrink-0 items-center justify-center gap-1 font-medium transition-colors aria-disabled:cursor-default aria-disabled:opacity-35',
        dock ? 'h-12 min-w-12 rounded-xl px-2 text-[13px]' : 'h-9 min-w-9 rounded-lg px-1.5 text-[12.5px]',
        wide && (dock ? 'px-3' : 'px-2'),
        active ? 'bg-accent-500/25 text-accent-200 ring-1 ring-accent-500/50' : disabled ? 'text-ink-100' : 'text-ink-100 hover:bg-ink-700/70',
      )}
    >
      {children}
    </button>
  );
}

export const Sep = ({ dock }: { dock: boolean }) => <span aria-hidden className={cn('sheet-sep shrink-0 bg-ink-700', dock ? 'mx-0.5 h-8 w-px' : 'mx-1 h-5 w-px')} />;

