import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

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
          <div className="h-8 w-8 rounded-lg bg-teal-600" />
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

          <span className="px-3 py-2 text-xs uppercase tracking-wide text-gray-400 dark:text-[var(--text-muted)]">
            Telemetry replay
          </span>
        </nav>
      </div>
    </>
  );
}
