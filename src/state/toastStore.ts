import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warn';
  title: string;
  body?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>, ttl?: number) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ttl = 5000) => {
    const id = seq++;
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) });
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, body?: string) => useToasts.getState().push({ kind: 'info', title, body }),
  success: (title: string, body?: string) => useToasts.getState().push({ kind: 'success', title, body }),
  warn: (title: string, body?: string) => useToasts.getState().push({ kind: 'warn', title, body }, 8000),
  error: (title: string, body?: string) => useToasts.getState().push({ kind: 'error', title, body }, 10000),
};
