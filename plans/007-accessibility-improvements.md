# Plan 007: Accessibility improvements

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 003 (mobile nav patterns)
- **Category**: security
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

The app has 7 ARIA attributes and 2 role attributes across 16 components. There's no skip-to-content link, no focus management, no keyboard navigation patterns, no live regions for dynamic content, and no form error announcements. Users with screen readers cannot effectively use this application. Beyond compliance, good accessibility improves the experience for everyone — keyboard users, power users, and assistive tech users.

## Current state

- 7 `aria-label` attributes (gauges, search, playback controls)
- 2 `role="img"` on SVGs
- No skip-to-content link
- No `aria-live` regions
- No focus trapping in modals/drawers
- SessionTable rows are clickable `<tr>` but not keyboard focusable
- Form inputs lack `aria-describedby` for error messages
- PID category headers lack `aria-expanded`

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/components/layout/AppShell.tsx` — skip-to-content, landmark roles
- `apps/frontend/src/components/layout/MobileDrawer.tsx` — focus trap (from plan 003)
- `apps/frontend/src/features/auth/Login.tsx` — form accessibility
- `apps/frontend/src/features/auth/Register.tsx` — form accessibility
- `apps/frontend/src/components/tables/SessionTable.tsx` — keyboard navigation
- `apps/frontend/src/components/telemetry/PidTogglePanel.tsx` — aria-expanded on categories
- `apps/frontend/src/components/telemetry/DecodedMetricsTable.tsx` — aria-live for content
- `apps/frontend/src/features/dashboard/PlaybackControls.tsx` — aria labels
- `apps/frontend/src/index.css` — focus visible styles

**Out of scope:**
- Screen reader testing with actual assistive tech (manual QA)
- WCAG 2.1 AA certification audit
- Color contrast fixes (covered by design token plan)

## Steps

### Step 1: Add focus-visible styles to index.css

```css
/* Accessible focus indicators */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Remove default outline for mouse users */
:focus:not(:focus-visible) {
  outline: none;
}
```

**Verify**: `grep -c "focus-visible" apps/frontend/src/index.css` → 1

### Step 2: Add skip-to-content link in AppShell

Add a visually hidden skip link as the first element in AppShell that becomes visible on focus:

```tsx
<a
  href="#main-content"
  className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:bg-blue-600 focus:text-white focus:px-4 focus:py-2 focus:rounded-md focus:font-medium"
>
  Skip to content
</a>
```

Add `id="main-content"` to the `<main>` element.

**Verify**: tab through AppShell — skip link appears as first focusable element

### Step 3: Add aria labels to AppShell landmarks

```tsx
<aside aria-label="Main navigation">
<header role="banner">
<main id="main-content" role="main">
<nav aria-label="Main navigation">
```

**Verify**: `grep -c "aria-label\|role=" apps/frontend/src/components/layout/AppShell.tsx` → at least 3

### Step 4: Improve form accessibility in Login/Register

For each form input:
1. Add `aria-describedby` pointing to the error message element
2. Add `id` to input and error elements
3. Add `aria-invalid` when there's an error

**Pattern:**
```tsx
<input
  id="login-email"
  type="email"
  required
  aria-invalid={!!error}
  aria-describedby={error ? 'login-error' : undefined}
  ...
/>
{error && (
  <p id="login-error" className="text-sm text-red-600" role="alert">
    {error}
  </p>
)}
```

**Verify**: form errors are announced by screen readers (role="alert")

### Step 5: Make SessionTable keyboard accessible

Change session rows from clickable `<tr>` to focusable elements:
1. Add `tabIndex={0}` to `<tr>`
2. Add `onKeyDown` handler for Enter/Space
3. Add `role="button"` to each row
4. Add `aria-label` with session name

**Verify**: Tab through session list, each row is focusable and activatable with Enter

### Step 6: Add aria-expanded to PidTogglePanel categories

Each category header button needs `aria-expanded={expanded}`:

```tsx
<button
  aria-expanded={expandedCategories.has(cat)}
  aria-controls={`category-${cat}`}
>
  {cat}
</button>
<div id={`category-${cat}`} role="group">
  {/* PID items */}
</div>
```

**Verify**: `grep -c "aria-expanded" apps/frontend/src/components/telemetry/PidTogglePanel.tsx` → at least 1

### Step 7: Add aria-live to dynamic content

- DecodedMetricsTable: add `aria-live="polite"` to the stats update area
- SessionSummaryCard: add `aria-live="polite"` to the gauge values (so screen readers announce changes during playback)
- PlaybackControls: add `aria-live="polite"` to the time display

**Verify**: screen reader announces gauge value changes during playback

### Step 8: Full build verification

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0

## Test plan

- Tab through entire app — focus-visible outline appears on every interactive element
- Skip link — first Tab shows "Skip to content", Enter jumps to main
- Login form — submit with empty fields, error announced
- Session list — Tab to rows, Enter opens session
- PID panel — Tab to categories, Enter toggles, aria-expanded correct
- Keyboard-only navigation — complete login → list session → open replay flow

## Done criteria

- [ ] Focus-visible styles in index.css
- [ ] Skip-to-content link in AppShell
- [ ] Landmark roles/labels in AppShell
- [ ] Form inputs have aria-describedby + aria-invalid
- [ ] SessionTable rows are keyboard focusable
- [ ] PidTogglePanel categories have aria-expanded
- [ ] Dynamic content has aria-live regions
- [ ] `npx vite build` exits 0

## STOP conditions

- Focus-visible styles conflict with Tremor component focus states
- aria-live causes excessive screen reader announcements during rapid playback
- Keyboard navigation breaks existing mouse interaction
