import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Home, Upload, Piano, Library, Settings as SettingsIcon } from 'lucide-react';
import { cn } from '../ui';
import { Toaster } from './Toaster';
import { useStudio } from '../../state/studioStore';
import { ImportStatusPill } from '../import/ImportStatusPill';

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="h-7 w-7" />
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-ink-50">
          Piano<span className="text-accent-400">Vision</span>
        </span>
      )}
    </div>
  );
}

export function AppShell() {
  const songId = useStudio((s) => s.song?.id);
  const location = useLocation();
  const inStudio = location.pathname.startsWith('/studio');
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
          'hidden shrink-0 flex-col border-r border-ink-800 bg-ink-900/80 md:flex',
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
            <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
              Everything stays in your browser. Songs are stored locally on this device.
            </p>
          </div>
        )}
      </aside>
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      {/* mobile bottom navigation */}
      <nav className="flex h-14 shrink-0 items-stretch border-t border-ink-800 bg-ink-900 md:hidden" aria-label="Main">
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
    </div>
  );
}
