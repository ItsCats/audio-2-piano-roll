import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useToasts } from '../../state/toastStore';
import { Button, cn } from '../ui';

const icons = { success: CheckCircle2, warn: AlertTriangle, error: XCircle, info: Info };
const tones = { success: 'text-ok', warn: 'text-warn', error: 'text-bad', info: 'text-accent-400' };

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-20 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 md:bottom-4" aria-live="polite">
      {toasts.map((t) => {
        const Icon = icons[t.kind];
        return (
          <div
            key={t.id}
            role={t.actions?.length ? 'alertdialog' : undefined}
            aria-label={t.actions?.length ? t.title : undefined}
            className="panel animate-fade-in pointer-events-auto flex gap-3 px-4 py-3"
          >
            <Icon size={18} className={cn('mt-0.5 shrink-0', tones[t.kind])} />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-ink-50">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[12.5px] break-words text-ink-300">{t.body}</p>}
              {t.actions && t.actions.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {t.actions.map((a) => (
                    <Button
                      key={a.label}
                      size="sm"
                      variant={a.variant ?? 'secondary'}
                      onClick={async () => {
                        const keep = (await a.onClick()) === false;
                        if (!keep) dismiss(t.id);
                      }}
                    >
                      {a.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <button className="focus-ring h-6 w-6 shrink-0 rounded text-ink-300 hover:text-ink-50" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} className="mx-auto" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
