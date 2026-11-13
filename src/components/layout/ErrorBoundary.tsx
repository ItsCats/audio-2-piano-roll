import { Component, type ReactNode } from 'react';
import { isChunkLoadError, reloadIfNewVersion } from '../../lib/newVersion';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
    // a part of the app that could not be loaded: usually a new version went online since this tab opened
    if (isChunkLoadError(error)) void reloadIfNewVersion();
  }
  render() {
    if (!this.state.error) return this.props.children;
    const update = isChunkLoadError(this.state.error);
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <div className="panel max-w-md p-6">
          <h1 className="text-lg font-semibold text-ink-50">{update ? 'This page could not be loaded' : 'Something went wrong'}</h1>
          <p className="mt-2 text-sm text-ink-300">
            {update ? 'A new version of Piano2Vision may be out, or the connection dropped. Reload to try again.' : this.state.error.message}
          </p>
          <p className="mt-2 text-xs text-ink-400">Your songs are stored on this device and are not affected.</p>
          <button className="mt-4 min-h-11 rounded-lg bg-accent-500 px-5 py-2 text-sm font-medium text-white" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
