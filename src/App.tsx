import { lazy, Suspense, useEffect, useLayoutEffect, useMemo } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { HomePage } from './pages/Home';
import { useLibrary } from './state/libraryStore';
import { requestPersistence } from './lib/storage/db';
import { useImport } from './state/importStore';
import { COMPUTER_SOUND_IMPORT, isLegacyYouTubeImport, needsDocumentSwitch, switchDocument } from './lib/isolation';

const ImportPage = lazy(() => import('./pages/Import'));
const StudioPage = lazy(() => import('./pages/Studio'));
const LibraryPage = lazy(() => import('./pages/Library'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const AccuracyPage = lazy(() => import('./pages/Accuracy'));
const CreditsPage = lazy(() => import('./pages/Credits'));
const LegalPage = lazy(() => import('./pages/Legal'));

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center text-ink-300">
      <Loader2 className="animate-spin" size={22} />
    </div>
  );
}

/**
 * Keeps the document's cross-origin isolation right for the route (src/lib/isolation.ts): moving
 * from a document loaded on an unknown path to an app route is a full page load, so the server's
 * headers for that route apply. While an import runs, a page load would cancel it, so the router
 * navigates in place and the document keeps its current isolation (single-threaded separation)
 * until a later navigation.
 */
function IsolationGate() {
  const location = useLocation();
  // old links to the removed YouTube tab (/import/youtube, /import?tab=youtube) → "Computer sound"
  const target = isLegacyYouTubeImport(location.pathname, location.search) ? COMPUTER_SOUND_IMPORT : null;
  // decided once per navigation: an import finishing later never reloads the page by itself
  const switching = useMemo(() => {
    const job = useImport.getState().job;
    const busy = !!job && job.stage !== 'done' && job.stage !== 'error';
    return !busy && needsDocumentSwitch(target ? '/import' : location.pathname);
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
            <Route path="import/youtube" element={<Navigate to={COMPUTER_SOUND_IMPORT} replace />} />
            <Route path="studio" element={<Suspense fallback={<PageFallback />}><StudioPage /></Suspense>} />
            <Route path="studio/:id" element={<Suspense fallback={<PageFallback />}><StudioPage /></Suspense>} />
            <Route path="library" element={<Suspense fallback={<PageFallback />}><LibraryPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
            <Route path="accuracy" element={<Suspense fallback={<PageFallback />}><AccuracyPage /></Suspense>} />
            <Route path="credits" element={<Suspense fallback={<PageFallback />}><CreditsPage /></Suspense>} />
            <Route path="privacy" element={<Suspense fallback={<PageFallback />}><LegalPage page="privacy" /></Suspense>} />
            <Route path="terms" element={<Suspense fallback={<PageFallback />}><LegalPage page="terms" /></Suspense>} />
            <Route path="copyright" element={<Suspense fallback={<PageFallback />}><LegalPage page="copyright" /></Suspense>} />
            <Route path="*" element={<HomePage />} />
            </Route>
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
