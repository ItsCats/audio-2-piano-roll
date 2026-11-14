import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Home, Upload, Piano, Library, Settings as SettingsIcon, Gauge, Heart, Code } from 'lucide-react';
import { SOURCE_CODE_LABEL, SOURCE_CODE_URL } from '../../lib/credits';
import { cn } from '../ui';
import { Toaster } from './Toaster';
import { useStudio } from '../../state/studioStore';
import { ImportStatusPill } from '../import/ImportStatusPill';
import { InterruptedImportNotice } from '../import/InterruptedImportNotice';
import { useStageFullscreen } from '../../state/fullscreenStore';
import { useSettings } from '../../state/settingsStore';

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="h-7 w-7" />
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-ink-50">
          Piano<span className="text-accent-400">2Vision</span>
        </span>
      )}
    </div>
  );
}

export function AppShell() {
  const songId = useStudio((s) => s.song?.id);
  const location = useLocation();
  const inStudio = location.pathname.startsWith('/studio');
  // the Studio's full screen: hide the app's navigation (sidebar, bottom tabs)
  const chromeHidden = useStageFullscreen((s) => s.mode !== 'off');
  // editing the sheet music on a phone: the bottom tabs make room for the music (back when Edit is off)
  const editing = useStudio((s) => s.editMode);
  const sheetView = useSettings((s) => s.sheet.view === 'sheet');
  const sheetEditing = editing && sheetView && inStudio;
  const nav = [
    { to: '/', label: 'Home', icon: Home, end: true },
    { to: '/import', label: 'Import Music', icon: Upload },
    { to: songId ? `/studio/${songId}` : '/studio', label: 'Piano Studio', icon: Piano },
    { to: '/library', label: 'My Library', icon: Library },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
  return (
    <div className="flex h-dvh w-full flex-col md:flex-row">
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-ink-800 bg-ink-900/80',
          !chromeHidden && 'md:flex',
          inStudio ? 'w-[68px] items-center' : 'w-[232px]',
        )}
      >
        <div className={cn('flex h-16 items-center', inStudio ? 'justify-center' : 'px-5')}>
          <Logo compact={inStudio} />
        </div>
        <nav className={cn('flex flex-1 flex-col gap-1', inStudio ? 'px-2' : 'px-3')} aria-label="Main">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={label}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                cn(
                  'focus-ring flex h-10 items-center gap-3 rounded-[10px] text-[13.5px] font-medium transition-colors',
                  inStudio ? 'w-11 justify-center' : 'px-3',
                  isActive || (label === 'Piano Studio' && inStudio)
                    ? 'bg-ink-750 text-ink-50 shadow-[inset_0_0_0_1px_var(--color-ink-700)]'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
                )
              }
            >
              <Icon size={18} strokeWidth={1.8} />
              {!inStudio && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>
        {!inStudio && (
          <div className="px-4 pb-4">
            <ImportStatusPill />
            <NavLink
              to="/accuracy"
              className={({ isActive }) =>
                cn('focus-ring mt-3 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]', isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:text-ink-100')
              }
            >
              <Gauge size={14} /> How accurate is it?
            </NavLink>
            <NavLink
              to="/credits"
              className={({ isActive }) =>
                cn('focus-ring mt-0.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]', isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:text-ink-100')
              }
            >
              <Heart size={14} /> Credits &amp; licenses
            </NavLink>
            <a
              href={SOURCE_CODE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring mt-0.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-300 hover:text-ink-100"
            >
              <Code size={14} /> {SOURCE_CODE_LABEL}
            </a>
            <p className="mt-1 flex flex-wrap gap-x-1.5 px-2 text-[11.5px] text-ink-400">
              <NavLink to="/privacy" className="focus-ring rounded hover:text-ink-100">Privacy</NavLink>
              <span aria-hidden="true">·</span>
              <NavLink to="/terms" className="focus-ring rounded hover:text-ink-100">Terms</NavLink>
              <span aria-hidden="true">·</span>
              <NavLink to="/copyright" className="focus-ring rounded hover:text-ink-100">Copyright</NavLink>
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
              Everything stays in your browser. Songs are stored locally on this device.
            </p>
          </div>
        )}
      </aside>
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      {/* mobile bottom navigation */}
      <nav className={cn('h-14 shrink-0 items-stretch border-t border-ink-800 bg-ink-900 md:hidden', chromeHidden || sheetEditing ? 'hidden' : 'flex')} aria-label="Main">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={label}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn('flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium', isActive ? 'text-accent-300' : 'text-ink-300')
            }
          >
            <Icon size={19} strokeWidth={1.8} />
            <span>{label.replace('Import Music', 'Import').replace('Piano Studio', 'Studio').replace('My Library', 'Library')}</span>
          </NavLink>
        ))}
      </nav>
      <Toaster />
      <InterruptedImportNotice />
    </div>
  );
}
