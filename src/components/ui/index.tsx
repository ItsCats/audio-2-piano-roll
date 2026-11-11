import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-accent-500 text-white hover:bg-accent-400 active:bg-accent-600 shadow-[0_6px_20px_-8px_rgba(109,140,255,0.7)]',
  secondary: 'bg-ink-700 text-ink-50 hover:bg-ink-600 border border-ink-600',
  subtle: 'bg-ink-800 text-ink-100 hover:bg-ink-700 border border-ink-700',
  ghost: 'text-ink-200 hover:text-ink-50 hover:bg-ink-700/60',
  danger: 'bg-bad/15 text-bad hover:bg-bad/25 border border-bad/30',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', icon, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'focus-ring inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-40',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' | 'lg' }
>(function IconButton({ label, active, size = 'md', className, children, ...rest }, ref) {
  const dim = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-12 w-12' : 'h-9 w-9';
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'focus-ring inline-flex shrink-0 items-center justify-center rounded-[10px] transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
        dim,
        active ? 'bg-accent-500/20 text-accent-300' : 'text-ink-200 hover:bg-ink-700/70 hover:text-ink-50',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className={cn('flex flex-col gap-1', disabled && 'opacity-40')}>
      <div className="flex items-center justify-between text-[12.5px]">
        <label htmlFor={id} className="text-ink-200">
          {label}
        </label>
        <span className="font-mono text-[11.5px] text-ink-300 tabular-nums">{format ? format(value) : value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ ['--fill' as string]: `${fill}%` }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex cursor-pointer items-center justify-between gap-3 py-0.5', disabled && 'pointer-events-none opacity-40')}>
      <span className="flex flex-col">
        <span className="text-[13px] text-ink-100">{label}</span>
        {hint && <span className="text-[11.5px] text-ink-300">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'focus-ring relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
          checked ? 'bg-accent-500' : 'bg-ink-600',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-150',
            checked && 'translate-x-4',
          )}
        />
      </button>
    </label>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={id} className="text-[12.5px] text-ink-200">
          {label}
        </label>
      )}
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
        className="focus-ring h-9 rounded-[10px] border border-ink-600 bg-ink-800 px-2.5 text-[13px] text-ink-50"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex rounded-[11px] border border-ink-700 bg-ink-900 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'focus-ring flex-1 rounded-[9px] font-medium whitespace-nowrap transition-colors duration-150',
            size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'bg-ink-600 text-ink-50 shadow-sm' : 'text-ink-300 hover:text-ink-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id} className="text-[13px] text-ink-100">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-ink-300 uppercase">{value}</span>
        <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-9" />
      </div>
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-ink-700/70 px-4 py-4 last:border-b-0">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'ok' | 'bad'; title?: string }) {
  const tones = {
    neutral: 'bg-ink-700 text-ink-200',
    accent: 'bg-accent-500/15 text-accent-300',
    warn: 'bg-warn/15 text-warn',
    ok: 'bg-ok/15 text-ok',
    bad: 'bg-bad/15 text-bad',
  };
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, indeterminate }: { value: number | null; indeterminate?: boolean }) {
  const ind = indeterminate || value === null;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-valuenow={ind ? undefined : Math.round((value ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
      {ind ? (
        <div className="absolute inset-y-0 w-1/3 animate-[indet_1.2s_ease-in-out_infinite] rounded-full bg-accent-500" />
      ) : (
        <div className="h-full rounded-full bg-accent-500 transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(1, value!)) * 100}%` }} />
      )}
      <style>{`@keyframes indet{0%{left:-35%}100%{left:100%}}`}</style>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'panel animate-fade-in flex max-h-[92dvh] w-full flex-col overflow-hidden outline-none',
          wide ? 'sm:max-w-5xl' : 'sm:max-w-lg',
        )}
      >
        <header className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink-50">{title}</h2>
          <IconButton label="Close" onClick={onClose} size="sm">
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-ink-700 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-800 text-ink-300">{icon}</div>
      <h3 className="text-[15px] font-semibold text-ink-50">{title}</h3>
      {children && <p className="max-w-sm text-[13px] text-ink-300">{children}</p>}
      {action}
    </div>
  );
}
