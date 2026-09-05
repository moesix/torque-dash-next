import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { getVersion } from '@/lib/api';

/** GitHub octocat mark — standard filled path (Simple Icons convention). */
const GITHUB_PATH =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-out navigation drawer for mobile viewports.
 *
 * Covers the sidebar links (Sessions, Settings) inside a modal dialog
 * with backdrop, Escape-to-close, focus-on-open, and dark-mode support.
 */
export default function MobileDrawer({ open, onClose }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    getVersion().then((v) => setVersion(v.version)).catch(() => {});
  }, []);

  // ── Close on Escape key ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // ── Auto-focus first nav item when drawer opens ──────────────────────
  useEffect(() => {
    if (!open || !drawerRef.current) return;
    const first = drawerRef.current.querySelector<HTMLButtonElement>(
      'nav button',
    );
    first?.focus();
  }, [open]);

  // ── Navigate and close ───────────────────────────────────────────────
  const go = (path: string) => {
    navigate(path);
    onClose();
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <>
      {/* Backdrop overlay — closes drawer on click */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`fixed inset-y-0 left-0 z-50 w-60 transform bg-white p-4 shadow-lg transition-transform duration-300 ease-in-out dark:bg-[var(--bg-card)] ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Branding */}
        <div className="mb-6 flex items-center gap-2">
          <img src="/brand/logo.svg" alt="" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-bold tracking-tight text-gray-900 dark:text-[var(--text-primary)]">
            TorqueDash-Next
          </span>
        </div>

        {/* Navigation links */}
        <nav className="flex flex-col gap-1 text-sm">
          <button
            onClick={() => go('/')}
            className={`rounded-md px-3 py-2 text-left font-medium hover:bg-gray-100 dark:hover:bg-[var(--bg-surface)] ${
              isActive('/')
                ? 'text-gray-900 dark:text-[var(--text-primary)]'
                : 'text-gray-600 dark:text-[var(--text-secondary)]'
            }`}
          >
            Sessions
          </button>
          <button
            onClick={() => go('/settings')}
            className={`rounded-md px-3 py-2 text-left font-medium hover:bg-gray-100 dark:hover:bg-[var(--bg-surface)] ${
              isActive('/settings')
                ? 'text-gray-900 dark:text-[var(--text-primary)]'
                : 'text-gray-600 dark:text-[var(--text-secondary)]'
            }`}
          >
            Settings
          </button>

          {version && (
            <span className="px-3 py-1 text-xs text-gray-400 dark:text-[var(--text-muted)]">
              v{version}
            </span>
          )}
          <a
            href="https://github.com/moesix/torque-dash-next/"
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-left font-medium text-gray-600 hover:bg-gray-100 dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-surface)]"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
              <path d={GITHUB_PATH} />
            </svg>
            GitHub
          </a>

          <span className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400 dark:text-[var(--text-muted)]">
            Telemetry replay
          </span>
        </nav>
      </div>
    </>
  );
}
