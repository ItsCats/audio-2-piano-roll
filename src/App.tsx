import { lazy, Suspense, useEffect, useLayoutEffect, useMemo } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { HomePage } from './pages/Home';
import { useLibrary } from './state/libraryStore';
import { requestPersistence } from './lib/storage/db';
import { useImport } from './state/importStore';
import { YOUTUBE_IMPORT_PATH, needsDocumentSwitch, switchDocument } from './lib/isolation';

const ImportPage = lazy(() => import('./pages/Import'));
const StudioPage = lazy(() => import('./pages/Studio'));
const LibraryPage = lazy(() => import('./pages/Library'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const AccuracyPage = lazy(() => import('./pages/Accuracy'));
const CreditsPage = lazy(() => import('./pages/Credits'));

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center text-ink-300">
      <Loader2 className="animate-spin" size={22} />
    </div>
  );
}

/**
 * Keeps the document's cross-origin isolation right for the route (src/lib/isolation.ts): entering
 * or leaving the YouTube import route is a full page load, so the server's headers for that route
 * apply. While an import runs, a page load would cancel it, so the router navigates in place and
 * the document keeps its current isolation (single-threaded separation or a YouTube tab that waits,
 * see Import.tsx) until a later navigation.
 */
function IsolationGate() {
  const location = useLocation();
  // old links (/import?tab=youtube) → the YouTube route
  const params = new URLSearchParams(location.search);
  const legacyYouTube = location.pathname.replace(/\/+$/, '') === '/import' && params.get('tab') === 'youtube';
  if (legacyYouTube) params.delete('tab');
  const target = legacyYouTube ? `${YOUTUBE_IMPORT_PATH}${params.size ? `?${params}` : ''}${location.hash}` : null;
  // decided once per navigation: an import finishing later never reloads the page by itself
  const switching = useMemo(() => {
    const job = useImport.getState().job;
    const busy = !!job && job.stage !== 'done' && job.stage !== 'error';
    return !busy && needsDocumentSwitch(legacyYouTube ? YOUTUBE_IMPORT_PATH : location.pathname);
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (switching) switchDocument(target ?? `${location.pathname}${location.search}${location.hash}`);
  }, [switching, target, location.pathname, location.search, location.hash]);
  if (switching) return <PageFallback />;
  if (target) return <Navigate to={target} replace />;
  return <Outlet />;
}

export function App() {
  useEffect(() => {
    void useLibrary.getState().refresh();
    void requestPersistence();
  }, []);
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route element={<AppShell />}>
            <Route element={<IsolationGate />}>
            <Route index element={<HomePage />} />
            <Route path="import" element={<Suspense fallback={<PageFallback />}><ImportPage /></Suspense>} />
            <Route path="import/youtube" element={<Suspense fallback={<PageFallback />}><ImportPage /></Suspense>} />
            <Route path="studio" element={<Suspense fallback={<PageFallback />}><StudioPage /></Suspense>} />
            <Route path="studio/:id" element={<Suspense fallback={<PageFallback />}><StudioPage /></Suspense>} />
            <Route path="library" element={<Suspense fallback={<PageFallback />}><LibraryPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
            <Route path="accuracy" element={<Suspense fallback={<PageFallback />}><AccuracyPage /></Suspense>} />
            <Route path="credits" element={<Suspense fallback={<PageFallback />}><CreditsPage /></Suspense>} />
            <Route path="*" element={<HomePage />} />
            </Route>
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
