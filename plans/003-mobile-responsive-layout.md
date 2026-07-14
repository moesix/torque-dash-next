# Plan 003: Mobile responsive layout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

The sidebar is `hidden md:flex` — below 768px it simply disappears with no alternative navigation. Users on phones or tablets **cannot access Settings** or navigate between pages. The ReplayDashboard also doesn't adapt well to narrow screens. This is a functional bug, not just a cosmetic issue.

## Current state

- `apps/frontend/src/components/layout/AppShell.tsx:22` — sidebar `hidden w-60 ... md:flex`
- `apps/frontend/src/components/layout/AppShell.tsx:24-45` — logo + nav links in sidebar only
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx:191` — `Grid numItemsLg={3}` stacks below lg
- No hamburger menu, no bottom nav, no mobile drawer
- No touch-optimized tap targets (many buttons are small)

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/components/layout/AppShell.tsx` — mobile header + drawer nav
- `apps/frontend/src/components/layout/MobileDrawer.tsx` — (new) slide-out drawer
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx` — responsive tweaks
- `apps/frontend/src/features/dashboard/PlaybackControls.tsx` — touch-friendly controls

**Out of scope:**
- Full mobile app rewrite
- Bottom tab navigation pattern (overkill for 3 pages)
- Touch gesture support for chart scrubbing (future)

## Steps

### Step 1: Create MobileDrawer component

Create `apps/frontend/src/components/layout/MobileDrawer.tsx` — a slide-out drawer from the left with the same nav links as the sidebar. Use a backdrop overlay, CSS transform for slide animation, and close on backdrop click or Escape key.

**Target shape:**
```tsx
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function MobileDrawer({ open, onClose }: MobileDrawerProps) {
  const navigate = useNavigate();
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Trap focus when open
  useEffect(() => {
    if (open) drawerRef.current?.focus();
  }, [open]);

  function handleNav(path: string) {
    onClose();
    navigate(path);
  }

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      {/* Drawer */}
      <div
        ref={drawerRef}
        className={`fixed inset-y-0 left-0 z-50 w-60 transform bg-white shadow-lg transition-transform duration-200 ease-out md:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
      >
        <div className="flex h-full flex-col p-4">
          <div className="mb-6 flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-600" />
            <span className="text-lg font-bold tracking-tight text-gray-900">
              TorqueDash
            </span>
          </div>
          <nav className="flex flex-col gap-1 text-sm">
            <button
              onClick={() => handleNav('/')}
              className="rounded-md px-3 py-2 text-left font-medium text-gray-900 hover:bg-gray-100"
            >
              Sessions
            </button>
            <button
              onClick={() => handleNav('/settings')}
              className="rounded-md px-3 py-2 text-left font-medium text-gray-600 hover:bg-gray-100"
            >
              Settings
            </button>
          </nav>
        </div>
      </div>
    </>
  );
}
```

**Verify**: file exists, `npx tsc --noEmit` passes

### Step 2: Update AppShell with mobile hamburger

Modify AppShell to:
1. Add `useState` for drawer open state
2. Add a hamburger button in the `<header>` (visible only below `md`)
3. Render `<MobileDrawer>` with the open state
4. Keep the existing sidebar for `md+`

**Changes to AppShell.tsx header:**
```tsx
// Add hamburger button before the branding text:
<button
  type="button"
  onClick={() => setDrawerOpen(true)}
  className="rounded-md p-2 text-gray-600 hover:bg-gray-100 md:hidden"
  aria-label="Open navigation"
>
  {/* Hamburger SVG: 3 horizontal lines */}
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
  </svg>
</button>
```

**Verify**: hamburger visible below md breakpoint, drawer opens/closes

### Step 3: Add dark: variants to MobileDrawer

Add `dark:bg-gray-800`, `dark:text-gray-200`, `dark:hover:bg-gray-700` to the drawer and nav buttons.

**Verify**: drawer looks correct in dark mode

### Step 4: Make PlaybackControls touch-friendly

Increase tap target sizes for mobile:
- Play/pause button: `min-w-[44px] min-h-[44px]` (Apple HIG minimum)
- Speed selector: `min-h-[44px]`
- Scrubber: `h-10` (larger track area)

**Verify**: controls are comfortably tappable on a 375px viewport

### Step 5: Responsive ReplayDashboard

The grid already stacks below `lg`. Additional tweaks:
- SessionSummaryCard gauges: ensure `flex-wrap` works on small screens
- OverlayChart: set `height: 250` on mobile (smaller than desktop 280)
- PID panel: make it collapsible on mobile (add expand/collapse toggle)

**Verify**: dashboard usable on 375px width without horizontal scroll

### Step 6: Full build verification

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0
- Test at 375px, 768px, 1024px, 1440px widths

## Test plan

- Resize browser to 375px — hamburger appears, sidebar hidden
- Click hamburger — drawer slides in
- Click nav link — drawer closes, page navigates
- Press Escape — drawer closes
- Click backdrop — drawer closes
- All pages render without horizontal scroll at 375px
- ReplayDashboard controls are tappable on mobile

## Done criteria

- [ ] `MobileDrawer.tsx` created with backdrop, slide animation, keyboard support
- [ ] AppShell has hamburger button below md breakpoint
- [ ] PlaybackControls have 44px minimum tap targets
- [ ] ReplayDashboard stacks cleanly on mobile
- [ ] No horizontal scroll at 375px on any page
- [ ] `npx vite build` exits 0

## STOP conditions

- Drawer animation causes layout shift on desktop
- Existing desktop layout breaks (sidebar still works at md+)
- Tremor Grid component doesn't handle the responsive pattern
