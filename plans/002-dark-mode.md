# Plan 002: Dark mode support

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 001 (CSS variables + `darkMode: 'class'` in tailwind config)
- **Category**: direction
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

TorqueDash is used in garages, workshops, and potentially at night while driving. A dark theme reduces eye strain in low-light environments and is the expected default for automotive/telemetry tools (Motec, AiM, RaceStudio all default dark). The `dark-tremor` color tokens already exist in the Tailwind config but are completely unused.

## Current state

- `apps/frontend/tailwind.config.ts:43-67` — `dark-tremor` palette defined but never used
- `apps/frontend/tailwind.config.ts` — no `darkMode` key (plan 001 adds `darkMode: 'class'`)
- `apps/frontend/src/index.css` — no `.dark` class variants
- No theme toggle component exists
- No `localStorage` persistence for theme preference
- All 16 components use light-only Tailwind classes

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/index.css` — `.dark` CSS variable overrides
- `apps/frontend/src/components/layout/AppShell.tsx` — add theme toggle button
- `apps/frontend/src/lib/theme.ts` — (new) theme persistence utility
- All components — add `dark:` Tailwind variants to key elements

**Out of scope:**
- ECharts theme (chart colors stay the same in dark mode — they're already colorful)
- Leaflet map tiles (add dark tile layer as future work)

## Steps

### Step 1: Add dark theme CSS variables

Append `.dark` class overrides to `index.css` that set all `--bg-*`, `--text-*`, `--border-*` variables to dark equivalents.

**Target: append to index.css:**
```css
.dark {
  --bg-base: #0f1117;
  --bg-card: #1a1d27;
  --bg-elevated: #252830;
  --bg-surface: #2d3039;

  --text-primary: #e4e4e7;
  --text-secondary: #a1a1aa;
  --text-muted: #71717a;

  --border-default: #2d3039;
  --border-strong: #3f4250;

  --accent: #fbbf24;
  --accent-hover: #f59e0b;

  --focus-ring: 0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent);
}
```

**Verify**: `grep -c "\.dark" apps/frontend/src/index.css` → at least 1

### Step 2: Create theme utility

Create `apps/frontend/src/lib/theme.ts`:
```ts
type Theme = 'light' | 'dark';

const STORAGE_KEY = 'torquedash-theme';

export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function toggleTheme(): Theme {
  const current = getTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
```

**Verify**: file exists and has no TypeScript errors

### Step 3: Apply theme on app load

In `apps/frontend/src/main.tsx`, import `applyTheme` and call `applyTheme(getTheme())` before rendering. This ensures the correct theme is applied before first paint (no flash).

**Changes to main.tsx:**
```ts
import { applyTheme, getTheme } from '@/lib/theme';
// Apply stored theme before render
applyTheme(getTheme());
```

**Verify**: `npx tsc --noEmit` → exit 0

### Step 4: Add theme toggle to AppShell

Add a sun/moon icon toggle button in the AppShell header, next to the logout button. Use inline SVG icons (no new dependency).

**Changes to AppShell.tsx:**
- Import `toggleTheme, getTheme` from `@/lib/theme`
- Add `useState` for current theme
- Add toggle button with sun/moon SVG icons in the `<header>` before the logout button

**Verify**: dev server shows toggle, clicking it switches dark/light, persists on reload

### Step 5: Add dark: variants to key components

Update these components with `dark:` Tailwind variants for backgrounds, text, and borders:

1. **AppShell.tsx** — sidebar bg, header bg, nav link hover
2. **Login.tsx** — card bg, input borders, text colors
3. **Register.tsx** — same pattern as Login
4. **SessionTable.tsx** — row hover, borders, text
5. **ReplayDashboard.tsx** — card backgrounds (Tremor Card handles most)
6. **SettingsPage.tsx** — card bg, input borders
7. **PlaybackControls.tsx** — bg, text
8. **PidTogglePanel.tsx** — search input, category headers
9. **DecodedMetricsTable.tsx** — row borders, text

Pattern for each component: add `dark:bg-gray-800`, `dark:text-gray-200`, `dark:border-gray-700` to key elements.

**Verify**: `npx vite build` → exit 0; all pages look correct in both modes

### Step 6: Verify full build

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0
- Toggle works on Login, SessionBrowser, ReplayDashboard, Settings

## Test plan

- Toggle dark/light on every page
- Refresh — theme persists
- System preference detection (clear localStorage, set OS to dark)
- No visual regressions in light mode

## Done criteria

- [ ] `.dark` CSS variables in `index.css`
- [ ] `lib/theme.ts` created with get/set/toggle/apply
- [ ] Theme applied before first render in `main.tsx`
- [ ] Toggle button in AppShell header
- [ ] All 9 listed components have `dark:` variants
- [ ] `npx vite build` exits 0
- [ ] Theme persists across page reloads

## STOP conditions

- Tremor components don't respect dark mode (check if Tremor v3 has built-in dark support — it does via `className="dark:bg-tremor-dark-background"`)
- CSS variable flash on page load (theme must be applied synchronously before React renders)
