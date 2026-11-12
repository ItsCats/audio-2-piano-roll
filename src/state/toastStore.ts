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

export const toast = {
  info: (title: string, body?: string) => useToasts.getState().push({ kind: 'info', title, body }),
  success: (title: string, body?: string) => useToasts.getState().push({ kind: 'success', title, body }),
  warn: (title: string, body?: string) => useToasts.getState().push({ kind: 'warn', title, body }, 8000),
  error: (title: string, body?: string) => useToasts.getState().push({ kind: 'error', title, body }, 10000),
};
