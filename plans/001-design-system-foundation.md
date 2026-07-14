# Plan 001: Design system foundation — tokens, typography, color palette

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

The entire UI uses generic system fonts (`ui-sans-serif, system-ui`) and hardcoded Tailwind color classes. There are no CSS custom properties, no design tokens, and no font pairing. Every component styles itself ad-hoc. This makes visual consistency impossible, dark mode unimplementable, and theming a manual per-file edit. This plan establishes the design foundation that all subsequent plans build on.

## Current state

- `apps/frontend/src/index.css:15` — body font: `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
- `apps/frontend/src/index.css:16-17` — hardcoded `background-color: #f9fafb; color: #111827`
- `apps/frontend/tailwind.config.ts:17-67` — Tremor color tokens only; no custom CSS variables
- `apps/frontend/index.html:6` — no font imports, no `<link>` to Google Fonts or similar
- No `src/styles/` directory, no `tokens.css`, no theme file

## Design decisions (from frontend-design skill)

**Typography pairing:**
- Display/headings: **Space Grotesk** (geometric sans, technical feel, distinctive character)
- Body/UI: **Space Grotesk** (clean, modern, excellent legibility at small sizes)
- Monospace data: **Martian Mono** (condensed, technical, perfect for telemetry codes and numbers)

**Color palette — industrial dark-first:**
- Background: `#0f1117` (dark base), `#1a1d27` (card), `#252830` (elevated)
- Surface: `#2d3039` (borders, subtle)
- Text: `#e4e4e7` (primary), `#a1a1aa` (secondary), `#71717a` (muted)
- Accent: `#f59e0b` (amber-500 — automotive/technical feel)
- Success: `#22c55e` (green-500)
- Danger: `#ef4444` (red-500)
- Chart colors: keep existing 10-color palette (already good)

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |
| Dev server | `cd apps/frontend && npx vite --host 10.7.7.7` | runs |

## Scope

**In scope:**
- `apps/frontend/index.html` — add font `<link>` tags
- `apps/frontend/src/index.css` — add CSS variables, font-family update, base theme
- `apps/frontend/tailwind.config.ts` — add CSS variable references to theme

**Out of scope:**
- Component-level class changes (future plans)
- Dark mode toggling logic (plan 002)
- Backend files

## Steps

### Step 1: Add font imports to index.html

Add Google Fonts `<link>` tags for JetBrains Mono (400, 500, 700) and IBM Plex Sans (400, 500, 600) in the `<head>`, with `preconnect` for performance.

**Target shape:**
```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Martian+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <title>TorqueDash Next</title>
</head>
```

**Verify**: `grep -c "fonts.googleapis.com" apps/frontend/index.html` → `1`

### Step 2: Create CSS custom properties in index.css

Replace the current `index.css` body block with CSS variables for the full color palette, plus updated font-family. Keep the Leaflet import and Tailwind directives.

**Target shape:**
```css
@import 'leaflet/dist/leaflet.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Typography */
  --font-display: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
  --font-body: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'Martian Mono', ui-monospace, monospace;

  /* Backgrounds */
  --bg-base: #f9fafb;
  --bg-card: #ffffff;
  --bg-elevated: #f3f4f6;
  --bg-surface: #e5e7eb;

  /* Text */
  --text-primary: #111827;
  --text-secondary: #6b7280;
  --text-muted: #9ca3af;

  /* Borders */
  --border-default: #e5e7eb;
  --border-strong: #d1d5db;

  /* Accent */
  --accent: #f59e0b;
  --accent-hover: #d97706;

  /* Semantic */
  --color-success: #22c55e;
  --color-danger: #ef4444;
  --color-warning: #f59e0b;
  --color-info: #3b82f6;

  /* Focus ring */
  --focus-ring: 0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent);
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  font-family: var(--font-body);
  background-color: var(--bg-base);
  color: var(--text-primary);
}

/* Monospace data styling */
.font-mono-data {
  font-family: var(--font-mono);
}
```

**Verify**: `grep -c "font-display" apps/frontend/src/index.css` → `1` (at least)

### Step 3: Update Tailwind config to reference CSS variables

Add `darkMode: 'class'` (prep for plan 002) and extend the theme with CSS variable references alongside existing Tremor tokens.

**Changes to `tailwind.config.ts`:**
1. Add `darkMode: 'class'` at the top level (after `content`)
2. Add to `theme.extend.colors`:
```ts
'brand-accent': 'var(--accent)',
'surface': {
  base: 'var(--bg-base)',
  card: 'var(--bg-card)',
  elevated: 'var(--bg-elevated)',
},
'fg': {
  DEFAULT: 'var(--text-primary)',
  secondary: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
},
```
3. Add to `theme.extend.fontFamily`:
```ts
display: ['var(--font-display)', 'sans-serif'],
body: ['var(--font-body)', 'sans-serif'],
mono: ['var(--font-mono)', 'monospace'],
```
4. Add to `theme.extend.boxShadow`:
```ts
'focus-ring': 'var(--focus-ring)',
```

**Verify**: `cd apps/frontend && npx tsc --noEmit` → exit 0 (tailwind config is TypeScript)

### Step 4: Verify build

**Verify**: `cd apps/frontend && npx vite build` → exit 0, no errors

## Test plan

- Visual: open dev server, confirm fonts load (Space Grotesk on headings/body, Martian Mono on code/data)
- Visual: confirm no color regressions (all existing Tailwind classes still work)
- Build: `npx vite build` succeeds
- Type: `npx tsc --noEmit` passes

## Done criteria

- [ ] `apps/frontend/index.html` has Google Fonts `<link>` tags
- [ ] `apps/frontend/src/index.css` has `:root` CSS variables
- [ ] `apps/frontend/tailwind.config.ts` has `darkMode: 'class'` and font-family extensions
- [ ] `npx vite build` exits 0
- [ ] `npx tsc --noEmit` exits 0
- [ ] Fonts visible in browser (JetBrains Mono on titles, IBM Plex Sans on body)

## STOP conditions

- Google Fonts CDN is unreachable from the build environment
- Existing Tremor components break visually (test by opening Login page)
- Tailwind config TypeScript errors
