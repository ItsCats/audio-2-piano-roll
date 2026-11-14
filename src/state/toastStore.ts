import { create } from 'zustand';

export interface ToastAction {
  label: string;
  /** return false to keep the toast open after the click */
  onClick: () => void | boolean | Promise<void | boolean>;
  variant?: 'primary' | 'secondary' | 'ghost';
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warn';
  title: string;
  body?: string;
  /** buttons under the text (a toast with actions stays until one is used or it is closed) */
  actions?: ToastAction[];
}

interface ToastState {
  toasts: Toast[];
  /** returns the toast's id; ttl 0 keeps it until dismissed */
  push: (t: Omit<Toast, 'id'>, ttl?: number) => number;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ttl = 5000) => {
    const id = seq++;
    const all = [...get().toasts, { ...t, id }];
    // at most 4 at once: the oldest plain toast goes first, a toast waiting for an answer stays
    while (all.length > 4) {
      const i = all.findIndex((x) => !x.actions?.length);
      all.splice(i >= 0 ? i : 0, 1);
    }
    set({ toasts: all });
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Buttons and how long the toast stays (ms; 0: until dismissed). Without `ttl`, a toast with actions stays until answered. */
export interface ToastOpts {
  actions?: ToastAction[];
  ttl?: number;
}

const show = (kind: Toast['kind'], defaultTtl: number) => (title: string, body?: string, opts?: ToastOpts) =>
  useToasts.getState().push({ kind, title, body, ...(opts?.actions?.length ? { actions: opts.actions } : {}) }, opts?.ttl ?? (opts?.actions?.length ? 0 : defaultTtl));

export const toast = {
  info: show('info', 5000),
  success: show('success', 5000),
  warn: show('warn', 8000),
  error: show('error', 10000),
};
