import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NavLink } from 'react-router';
import { useVersion } from '@/lib/useVersion';
import { GitHubLink } from '@/components/layout/brand';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-out navigation drawer for mobile viewports.
 *
 * Covers the sidebar links (Sessions, Settings) inside a modal dialog with
 * backdrop, Escape-to-close, focus-on-open, focus-restore-on-close, and
 * dark-mode support.
 *
 * Containment model: a native `<dialog showModal()>` was rejected because
 * native dialogs can't transition their enter/exit slides without
 * `@starting-style` gymnastics, and the drawer's CSS slide
 * (translate-x-full ⇄ translate-x-0) is the core interaction. Instead the
 * AppShell page rail (`#app-page-rail`, the wrapper around `<header>` +
 * `<main>`) is marked `inert` while the drawer is open, so background
 * content is neither tabbable nor click-targetable; the in-panel Tab wrap
 * below then loops the only remaining focusables — the drawer itself.
 * Assumption: `inert` is broadly implemented (Chrome 102+, Firefox 112+,
 * Safari 15.5+ — 2022 and later), so no attribute-fallback shims here.
 *
 * While closed the panel is unmounted-ish: it stays in the DOM **only**
 * for the 300ms exit slide, held `inert` + `aria-hidden` so nothing inside
 * it is visible to AT or reachable by Tab. When fully closed it unmounts.
 */
const EXIT_MS = 300;

export default function MobileDrawer({ open, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const { version } = useVersion();
  // Rendered on open immediately; on close, kept mounted for one slide
  // duration (animation preserved), then unmounted.
  const [mounted, setMounted] = useState(open);
  // Enter-slide state: on open the panel first paints at
  // `-translate-x-full`, then a double rAF flips it to `translate-x-0` so
  // the CSS transition between the two actually plays (mounting directly
  // at `translate-x-0` in the same commit that `open` flips skipped the
  // enter animation entirely). On close this flips back immediately so the
  // exit slide runs during the 300ms unmount delay above.
  const [slideIn, setSlideIn] = useState(false);
  // Tracks whether the drawer opened this cycle — used to restore focus to
  // the hamburger on close without stealing focus on the initial closed
  // mount (the restore effect also fires for `open === false` on mount).
  const wasOpenRef = useRef(open);

  // ── Mounted/enter/exit choreography ──────────────────────────────────
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      setMounted(true);
      // Double rAF: first frame commits the offscreen paint, second flips
      // `slideIn → true` so the browser interpolates the enter slide.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setSlideIn(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setSlideIn(false);
    const t = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  // ── Close on Escape key ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // ── Modal containment: the page rail goes inert while open ──────────
  // Declared BEFORE the focus-restore effect below so on close the rail is
  // un-inerted before the hamburger (inside it) is focused.
  useEffect(() => {
    const rail = document.getElementById('app-page-rail');
    if (!rail) return; // rendered outside AppShell (standalone/tests)
    rail.toggleAttribute('inert', open);
    return () => rail.removeAttribute('inert');
  }, [open]);

  // ── Auto-focus first nav item when drawer opens ──────────────────────
  // Deps include `mounted`: the panel ref only exists once the close-delay
  // lifecycle has (re)mounted it, so keying on `open` alone raced the
  // open→close→reopen path and focus never landed.
  useEffect(() => {
    if (!open || !mounted || !drawerRef.current) return;
    drawerRef.current.querySelector<HTMLAnchorElement>('nav a')?.focus({
      preventScroll: true,
    });
  }, [open, mounted]);

  // ── Focus restore on close ───────────────────────────────────────────
  // Return keyboard focus to the hamburger (the drawer's controller —
  // AppShell pairs them via aria-controls/id, see mobile-nav-toggle).
  // Guarded by wasOpenRef so the initial closed mount doesn't focus it.
  useEffect(() => {
    if (open || !wasOpenRef.current) return;
    wasOpenRef.current = false;
    document.getElementById('mobile-nav-toggle')?.focus({ preventScroll: true });
  }, [open]);

  // ── Focus loop while open ────────────────────────────────────────────
  // A modal drawer shouldn't Tab out into the page behind it; wrap at the
  // ends of its focusable list. Complete because the page rail sits
  // `inert` while open (see Containment model above).
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || e.key !== 'Tab') return;
    const panel = drawerRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!mounted) return null;

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

      {/* Drawer panel. inert+aria-hidden while closing: inert blocks Tab and
          AT access during the 300ms exit slide. */}
      <div
        ref={drawerRef}
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        aria-hidden={!open}
        inert={!open}
        onKeyDown={trapTab}
        className={`fixed inset-y-0 left-0 z-50 w-60 transform bg-surface-card p-4 shadow-lg transition-transform duration-300 ease-in-out ${
          slideIn ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Branding */}
        <div className="mb-6 flex items-center gap-2">
          <img src="/brand/logo.svg" alt="" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-bold tracking-tight text-fg">
            TorqueDash-Next
          </span>
        </div>

        {/* Navigation links — NavLink so active state matches the desktop
            sidebar (elevated surface + accent text). */}
        <nav aria-label="Main navigation" className="flex flex-col gap-1 text-sm">
          <NavLink
            to="/"
            end
            onClick={onClose}
            className={({ isActive }) => navLinkClass(isActive)}
          >
            Sessions
          </NavLink>
          <NavLink
            to="/settings"
            end
            onClick={onClose}
            className={({ isActive }) => navLinkClass(isActive)}
          >
            Settings
          </NavLink>

          {version && (
            <span className="px-3 py-1 text-xs text-fg-muted">
              v{version}
            </span>
          )}
          <GitHubLink onClick={onClose} className="text-left" />

          <span className="px-3 py-2 text-xs uppercase tracking-wide text-fg-muted">
            Telemetry replay
          </span>
        </nav>
      </div>
    </>
  );
}

/** Active nav styling — shared shape between AppShell sidebar and this
 *  drawer: elevated surface + 2px accent bar + accent text. */
export function navLinkClass(isActive: boolean): string {
  const base =
    'relative rounded-md px-3 py-2 font-medium transition-colors hover:bg-surface-elevated';
  return isActive
    ? `${base} bg-surface-elevated text-fg sidebar-active`
    : `${base} text-fg-secondary hover:text-fg`;
}
