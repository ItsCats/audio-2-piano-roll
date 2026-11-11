import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <div className="panel max-w-md p-6">
          <h1 className="text-lg font-semibold text-ink-50">Something went wrong</h1>
          <p className="mt-2 text-sm text-ink-300">{this.state.error.message}</p>
          <p className="mt-2 text-xs text-ink-400">Your songs are stored locally and are not affected.</p>
          <button className="mt-4 rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white" onClick={() => location.reload()}>
            Reload Piano2Vision
          </button>
        </div>
      </div>
    );
  }
}
