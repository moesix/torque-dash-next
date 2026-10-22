import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { logout } from '@/lib/api';
import MobileDrawer from '@/components/layout/MobileDrawer';
import { navLinkClass } from '@/components/layout/MobileDrawer';
import { toggleTheme, getTheme } from '@/lib/theme';
import { useVersion } from '@/lib/useVersion';
import { GitHubLink } from '@/components/layout/brand';

/**
 * Application chrome: persistent sidebar + topbar with logout. Child routes
 * render through <Outlet/>.
 */
export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  const { version } = useVersion();

  async function onLogout() {
    try {
      await logout();
    } catch {
      // ignore — we redirect regardless
    }
    navigate('/login');
  }

  return (
    <div className="flex h-full w-full bg-surface-base">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:bg-accent focus:text-accent-ink focus:px-4 focus:py-2 focus:rounded-md focus:font-medium"
      >
        Skip to content
      </a>
      <aside
        aria-label="Main navigation"
        className="hidden w-60 shrink-0 flex-col bg-surface-card p-4 shadow-[1px_0_0_0_var(--border-default),4px_0_8px_-2px_rgba(0,0,0,0.05)] md:flex"
      >

        <div className="mb-6 flex items-center gap-2">
          <img src="/brand/logo.svg" alt="" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-bold tracking-tight text-fg">
            TorqueDash-Next
          </span>
        </div>
        <nav className="flex flex-col gap-1 py-1 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) => navLinkClass(isActive)}
          >
            Sessions
          </NavLink>
          <NavLink
            to="/settings"
            end
            className={({ isActive }) => navLinkClass(isActive)}
          >
            Settings
          </NavLink>
          {version && (
            <span className="px-3 py-1 text-xs text-fg-muted">
              v{version}
            </span>
          )}
          <GitHubLink />
          <span className="px-3 py-2 text-xs uppercase tracking-wide text-fg-muted">
            Telemetry replay
          </span>
        </nav>
      </aside>

      {/* Page rail: the <header>+<main> stack. The MobileDrawer marks this
          wrapper inert while it is open (#app-page-rail), which is what keeps
          background content untouchable behind the modal drawer. The desktop
          <aside> is display:none below md (never focusable/visible), so it
          doesn't need the inert treatment. */}
      <div id="app-page-rail" className="flex min-w-0 flex-1 flex-col">
        <header role="banner" className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-card px-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              id="mobile-nav-toggle"
              aria-controls="mobile-nav-drawer"
              onClick={() => setDrawerOpen(true)}
              className="rounded-md p-2 text-fg-muted hover:bg-surface-elevated hover:text-fg md:hidden min-h-[44px] min-w-[44px]"
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
            <span className="text-sm font-medium text-fg-secondary">
              TorqueDash-Next
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = toggleTheme();
                setTheme(next);
              }}
              className="min-h-[44px] min-w-[44px] rounded-md p-2.5 text-fg-secondary hover:bg-surface-elevated hover:text-fg"
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
              className="min-h-[44px] rounded-lg border border-border bg-surface-card px-3 py-2.5 text-sm font-medium text-fg-secondary shadow-xs transition hover:bg-surface-elevated hover:text-fg"
            >
              Log out
            </button>
          </div>
        </header>
        <main id="main-content" className="scrollable-area min-h-0 flex-1 overflow-auto p-4">
          {/* Content rail: capped at 72rem and centered so dense views stop
              stretching edge-to-edge on ultra-wide (≥1440px) screens. Routes
              that self-constrain (e.g. Settings max-w-2xl) sit inside it. */}
          <div className="mx-auto w-full max-w-6xl animate-fade-in" key={location.pathname}>
            <Outlet />
          </div>
        </main>
      </div>

      <MobileDrawer
        open={drawerOpen}
        /* Focus restore target on close (see MobileDrawer's focus-restore
           effect — the button pairs with the panel via aria-controls). */
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
