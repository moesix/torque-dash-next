import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { logout } from '@/lib/api';
import MobileDrawer from '@/components/layout/MobileDrawer';
import { toggleTheme, getTheme } from '@/lib/theme';

/**
 * Application chrome: persistent sidebar + topbar with logout. Child routes
 * render through <Outlet/>.
 */
export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme());

  async function onLogout() {
    try {
      await logout();
    } catch {
      // ignore — we redirect regardless
    }
    navigate('/login');
  }

  return (
    <div className="flex h-full w-full bg-gray-50 dark:bg-[var(--bg-base)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:bg-teal-700 focus:text-white focus:px-4 focus:py-2 focus:rounded-md focus:font-medium"
      >
        Skip to content
      </a>
      <aside aria-label="Main navigation" className="hidden w-60 shrink-0 flex-col bg-white p-4 shadow-[1px_0_0_0_var(--border-default),4px_0_8px_-2px_rgba(0,0,0,0.05)] dark:bg-[var(--bg-card)] md:flex">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-teal-600" />
          <span className="text-lg font-bold tracking-tight text-gray-900 dark:text-[var(--text-primary)]">
            TorqueDash-Next
          </span>
        </div>
        <nav className="flex flex-col gap-1 text-sm text-gray-600 dark:text-[var(--text-secondary)]">
          <a
            href="/"
            className="rounded-md px-3 py-2 font-medium text-gray-900 hover:bg-gray-100 dark:text-[var(--text-primary)] dark:hover:bg-[var(--bg-surface)]"
          >
            Sessions
          </a>
          <a
            href="/settings"
            className="rounded-md px-3 py-2 font-medium text-gray-600 hover:bg-gray-100 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-surface)]"
          >
            Settings
          </a>
          <span className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400 dark:text-[var(--text-muted)]">
            Telemetry replay
          </span>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header role="banner" className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-[var(--border-default)] dark:bg-[var(--bg-card)]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="rounded-md p-2 text-gray-500 hover:bg-gray-100 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-surface)] md:hidden"
              aria-label="Open navigation"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
            <span className="text-sm font-medium text-gray-500 dark:text-[var(--text-secondary)]">
              TorqueDash Next
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = toggleTheme();
                setTheme(next);
              }}
              className="rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-surface)]"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? (
                /* Sun icon */
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                /* Moon icon */
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-[var(--border-strong)] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-surface)]"
            >
              Log out
            </button>
          </div>
        </header>
        <main id="main-content" className="scrollable-area min-h-0 flex-1 overflow-auto p-4">
          <div className="animate-fade-in" key={location.pathname}>
            <Outlet />
          </div>
        </main>
      </div>

      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
