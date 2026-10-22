// @vitest-environment jsdom
/**
 * Regression tests for the MobileDrawer (AppShell mobile nav) modal
 * behaviour: focus-on-open, focus-restore-to-hamburger on close, the
 * ~300ms-delayed unmount (exit slide), and the page-rail `inert`
 * containment — the piece that keeps background content untouchable while
 * the drawer is open.
 *
 * Mount strategy: AppShell is mounted for real inside a MemoryRouter (same
 * intent as printFlow.test.tsx mounting ReplayDashboard) because the page
 * rail (`#app-page-rail`) and the hamburger (`#mobile-nav-toggle`) live in
 * AppShell, not the drawer — testing MobileDrawer standalone would only
 * excercise the drawer's no-rail fallback branches.
 *
 * jsdom gaps bridged (printFlow pattern):
 *  - requestAnimationFrame is not implemented in jsdom: it is stubbed to
 *    setTimeout(0) so vitest's fake timers drive the drawer's double-rAF
 *    enter-slide chain from the same clock as the 300ms unmount timer.
 * jsdom gaps bridged/stubbed (printFlow pattern):
 *  - requestAnimationFrame is not implemented: stubbed to setTimeout(0) so
 *    vitest's fake timers drive the drawer's double-rAF enter-slide chain
 *    from the same clock as the 300ms unmount timer.
 *  - window.matchMedia is not implemented: stubbed (getTheme in lib/theme
 *    consults prefers-color-scheme during AppShell's first render).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import AppShell from '@/components/layout/AppShell';

// Real network/IO out — AppShell only needs `logout`, and the version badge
// must not race the fake-timer clock with an unresolvable jsdom fetch.
vi.mock('@/lib/api', () => ({
  logout: vi.fn(async () => {}),
  getVersion: vi.fn(async () => ({ version: '0.0.0-test' })),
}));

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/sessions']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<div>page content rail</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const hamburger = () =>
  screen.getByRole('button', { name: 'Open navigation' });
const drawer = () => screen.getByRole('dialog', { name: 'Navigation' });
const drawerSessionsLink = () =>
  within(drawer()).getByRole('link', { name: 'Sessions' });
/** Presence query for the exit-slide window, where the panel is
 *  aria-hidden + inert BY DESIGN (getByRole's accessibility filter drops
 *  both, so only a direct DOM lookup can observe the lingering panel). */
const drawerInDom = () => document.getElementById('mobile-nav-drawer');

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom exposes neither rAF nor matchMedia; bridge/stub both (printFlow
  // pattern). rAF → setTimeout(0) keeps the drawer's double-rAF enter-slide
  // chain on the same fake timer clock as the 300ms unmount timer.
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number,
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    (id: number) => clearTimeout(id),
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  // Unmount FIRST, while the rAF bridge + fake timers are still installed —
  // the drawer's rAF-chain cleanup must pair against the same clock it
  // scheduled on (RTL's own auto-cleanup otherwise fires after the unstubs
  // and sinon's fake clock rejects the mismatched cancel pair).
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MobileDrawer', () => {
  it('focuses the first nav link after opening with the hamburger', async () => {
    renderShell();

    await act(async () => {
      fireEvent.click(hamburger());
    });

    // "after microtasks" — the focus effect runs on the commit following
    // the drawer's mount (deps [open, mounted], the ref exists by then).
    expect(document.activeElement).toBe(drawerSessionsLink());
  });

  it('keeps the drawer mounted ~300ms after close, then unmounts it (exit slide)', async () => {
    renderShell();

    await act(async () => {
      fireEvent.click(hamburger());
    });

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    // Still mid-exit-slide: the panel lingers for the unmount delay
    // (aria-hidden during the slide, hence the hidden-presence query).
    expect(drawerInDom()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
  });

  it('marks the AppShell page rail inert while open, and restores it on close', async () => {
    renderShell();
    const rail = document.getElementById('app-page-rail');
    expect(rail).not.toBeNull();
    expect(rail?.hasAttribute('inert')).toBe(false);

    await act(async () => {
      fireEvent.click(hamburger());
    });
    expect(rail?.hasAttribute('inert')).toBe(true);
    // Positive check of the containment semantics the attribute implies.
    expect(rail?.getAttribute('inert')).toBe('');

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(rail?.hasAttribute('inert')).toBe(false);
  });

  it('restores focus to the hamburger on close — and again on reopen (dead-autofocus regression)', async () => {
    renderShell();

    await act(async () => {
      fireEvent.click(hamburger());
    });
    expect(document.activeElement).toBe(drawerSessionsLink());

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    act(() => {
      vi.advanceTimersByTime(300); // full unmount
    });
    expect(document.activeElement).toBe(hamburger());

    // Reopen after the panel fully unmounted: focus must land in the dialog
    // again (the old implementation keyed autofocus on `open` alone and
    // skipped this close→unmount→reopen cycle).
    await act(async () => {
      fireEvent.click(hamburger());
    });
    expect(document.activeElement).toBe(drawerSessionsLink());
  });
});
