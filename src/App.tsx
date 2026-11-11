import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { HomePage } from './pages/Home';
import { useLibrary } from './state/libraryStore';
import { requestPersistence } from './lib/storage/db';

const ImportPage = lazy(() => import('./pages/Import'));
const StudioPage = lazy(() => import('./pages/Studio'));
const LibraryPage = lazy(() => import('./pages/Library'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const AccuracyPage = lazy(() => import('./pages/Accuracy'));

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center text-ink-300">
      <Loader2 className="animate-spin" size={22} />
    </div>
  );
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
            <Route index element={<HomePage />} />
            <Route path="import" element={<Suspense fallback={<PageFallback />}><ImportPage /></Suspense>} />
            <Route path="studio" element={<Suspense fallback={<PageFallback />}><StudioPage /></Suspense>} />
            <Route path="studio/:id" element={<Suspense fallback={<PageFallback />}><StudioPage /></Suspense>} />
            <Route path="library" element={<Suspense fallback={<PageFallback />}><LibraryPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>} />
            <Route path="accuracy" element={<Suspense fallback={<PageFallback />}><AccuracyPage /></Suspense>} />
            <Route path="*" element={<HomePage />} />
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
