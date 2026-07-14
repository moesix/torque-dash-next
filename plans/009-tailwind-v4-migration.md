# Plan 009: Tailwind CSS v3.4 → v4.3.2 Migration

## Context

The app currently runs Tailwind CSS v3.4.10 with Tremor v3.18.3. Tailwind v4.3.2 is a
major release with a CSS-first configuration model, removing `safelist` and `content`
arrays in favor of `@theme` directives and `@source inline(...)` in CSS. The goal is
to modernize the Tailwind setup, reduce config complexity, and prepare for future
maintenance.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tremor compatibility | Keep Tremor v3 + use `@source inline(...)` shim | Stable, battle-tested approach; Tremor v4 still beta |
| Config approach | Minimal JS config + CSS `@theme` | JS config needed for `@source inline()` patterns; `@theme` for tokens |
| Plugin | `@tailwindcss/vite` (replaces PostCSS plugin) | Recommended for Vite projects; faster, simpler |
| `darkMode` config | Remove from JS config | Default in v4 (`class` mode is default) |

## Files Affected

| File | Action | Purpose |
|------|--------|---------|
| `apps/frontend/package.json` | Edit | Upgrade `tailwindcss`, add `@tailwindcss/vite`, remove `autoprefixer` |
| `apps/frontend/vite.config.ts` | Edit | Add `@tailwindcss/vite` plugin |
| `apps/frontend/postcss.config.js` | Delete | No longer needed with `@tailwindcss/vite` |
| `apps/frontend/src/index.css` | Rewrite | Replace directives with `@import "tailwindcss"`, add `@config`, `@source`, `@theme` |
| `apps/frontend/tailwind.config.ts` | Rewrite | Remove `darkMode`, `content`, `theme`; keep only `safelist` patterns for `@source` reference |

## Step-by-Step

### Step 1: Create branch
```
git checkout -b feat/tailwind-v4-migration development
```

### Step 2: Update package.json
Run upgrade commands in sequence:
```bash
cd apps/frontend
npx @tailwindcss/upgrade  # automated codemod
npm install -D @tailwindcss/vite
npm uninstall autoprefixer  # no longer needed
```

### Step 3: Update vite.config.ts
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
```

### Step 4: Delete postcss.config.js
```bash
rm apps/frontend/postcss.config.js
```

### Step 5: Rewrite index.css
```css
@import "tailwindcss";
@config "../tailwind.config.ts";

@source "../node_modules/@tremor/react/dist/**/*.{js,ts,jsx,tsx}";
@source "../node_modules/react-leaflet/**/*.{js,ts,jsx,tsx}";

/* ── Tremor v3 safelist shim ── */
@source inline('{hover:ui-selected:}bg-{tremor,dark-tremor}-{brand,background,border,ring,content}-{faint,muted,subtle,DEFAULT,emphasis,inverted}');
@source inline('{hover:ui-selected:}text-{tremor,dark-tremor}-{brand,background,border,ring,content}-{faint,muted,subtle,DEFAULT,emphasis,inverted}');
@source inline('{hover:ui-selected:}ring-{tremor,dark-tremor}-{brand,background,border,ring,content}-{faint,muted,subtle,DEFAULT,emphasis,inverted}');
@source inline('{hover:ui-selected:}stroke-{tremor,dark-tremor}-{brand,background,border,ring,content}-{faint,muted,subtle,DEFAULT,emphasis,inverted}');
@source inline('{hover:ui-selected:}border-{tremor,dark-tremor}-{brand,background,border,ring,content}-{faint,muted,subtle,DEFAULT,emphasis,inverted}');
@source inline('{hover:ui-selected:}fill-{tremor,dark-tremor}-{brand,background,border,ring,content}-{faint,muted,subtle,DEFAULT,emphasis,inverted}');
@source inline('{hover:ui-selected:}bg-{tremor,dark-tremor}-{brand,background,content}');
@source inline('{hover:ui-selected:}text-{tremor,dark-tremor}-{brand,background,content}');
@source inline('{hover:ui-selected:}ring-{tremor,dark-tremor}-{brand,background,content}');
@source inline('{hover:ui-selected:}border-{tremor,dark-tremor}-{brand,background,content}');
@source inline('{hover:ui-selected:}stroke-{tremor,dark-tremor}-{brand,background,content}');
@source inline('{hover:ui-selected:}fill-{tremor,dark-tremor}-{brand,background,content}');
@source inline('shadow-{tremor,dark-tremor}-{input,card,dropdown}');
@source inline('rounded-tremor-{small,default,full}');
@source inline('text-tremor-{label,default,title,metric}');

@theme {
  --color-brand-accent: var(--accent);
  --color-surface-base: var(--bg-base);
  --color-surface-card: var(--bg-card);
  --color-surface-elevated: var(--bg-elevated);
  --color-fg: var(--text-primary);
  --color-fg-secondary: var(--text-secondary);
  --color-fg-muted: var(--text-muted);

  /* Tremor tokens */
  --color-tremor-brand-faint: #eff6ff;
  --color-tremor-brand-muted: #bfdbfe;
  --color-tremor-brand-subtle: #60a5fa;
  --color-tremor-brand: #3b82f6;
  --color-tremor-brand-emphasis: #1d4ed8;
  --color-tremor-brand-inverted: #ffffff;
  --color-tremor-background-muted: #f9fafb;
  --color-tremor-background-subtle: #f3f4f6;
  --color-tremor-background: #ffffff;
  --color-tremor-background-emphasis: #374151;
  --color-tremor-border: #e5e7eb;
  --color-tremor-ring: #e5e7eb;
  --color-tremor-content-subtle: #9ca3af;
  --color-tremor-content: #6b7280;
  --color-tremor-content-emphasis: #374151;
  --color-tremor-content-strong: #111827;
  --color-tremor-content-inverted: #ffffff;

  --color-dark-tremor-brand-faint: #0B1229;
  --color-dark-tremor-brand-muted: #172554;
  --color-dark-tremor-brand-subtle: #1e40af;
  --color-dark-tremor-brand: #3b82f6;
  --color-dark-tremor-brand-emphasis: #60a5fa;
  --color-dark-tremor-brand-inverted: #030712;
  --color-dark-tremor-background-muted: #131A2B;
  --color-dark-tremor-background-subtle: #1f2937;
  --color-dark-tremor-background: #111827;
  --color-dark-tremor-background-emphasis: #d1d5db;
  --color-dark-tremor-border: #1f2937;
  --color-dark-tremor-ring: #1f2937;
  --color-dark-tremor-content-subtle: #4b5563;
  --color-dark-tremor-content: #6b7280;
  --color-dark-tremor-content-emphasis: #e5e7eb;
  --color-dark-tremor-content-strong: #f9fafb;
  --color-dark-tremor-content-inverted: #000000;

  /* Shadows */
  --shadow-tremor-input: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-tremor-card: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --shadow-tremor-dropdown: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-dark-tremor-input: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-dark-tremor-card: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --shadow-dark-tremor-dropdown: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-focus-ring: 0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent);

  /* Border radius */
  --radius-tremor-small: 0.375rem;
  --radius-tremor-default: 0.5rem;
  --radius-tremor-full: 9999px;

  /* Font sizes */
  --text-tremor-label: 0.75rem;
  --text-tremor-default: 0.875rem;
  --text-tremor-title: 1.125rem;
  --text-tremor-metric: 1.875rem;

  /* Font families */
  --font-display: var(--font-display);
  --font-body: var(--font-body);
  --font-mono: var(--font-mono);
}

/* ── Custom variant for dark mode (class-based, persisted via localStorage) ── */
@custom-variant dark (&:where(.dark, .dark *));

/* ── Dark theme overrides ── */
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
  --color-success: #22c55e;
  --color-danger: #ef4444;
  --color-warning: #fbbf24;
  --color-info: #60a5fa;
  --focus-ring: 0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent);
}

/* ── Accessible focus indicators ── */
:focus-visible {
  outline: 2px solid var(--accent, #f59e0b);
  outline-offset: 2px;
}

:focus:not(:focus-visible) {
  outline: none;
}

/* ── Skeleton / shimmer animation ── */
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-elevated, #f3f4f6) 25%,
    var(--bg-surface, #e5e7eb) 50%,
    var(--bg-elevated, #f3f4f6) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 0.375rem;
}

/* ── Page transitions ── */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.animate-fade-in {
  animation: fadeIn 0.3s ease-out both;
}

/* ── Staggered reveal ── */
@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

.animate-slide-up { animation: slideUp 0.4s ease-out both; }
.animate-slide-up-delay-1 { animation: slideUp 0.4s ease-out 0.1s both; }
.animate-slide-up-delay-2 { animation: slideUp 0.4s ease-out 0.2s both; }
.animate-slide-up-delay-3 { animation: slideUp 0.4s ease-out 0.3s both; }
.animate-slide-up-delay-4 { animation: slideUp 0.4s ease-out 0.4s both; }

/* ── Card hover ── */
.card-hover {
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
.card-hover:hover {
  box-shadow: 0 4px 12px 0 rgb(0 0 0 / 0.12);
  transform: translateY(-1px);
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .animate-fade-in,
  .animate-slide-up,
  .animate-slide-up-delay-1,
  .animate-slide-up-delay-2,
  .animate-slide-up-delay-3,
  .animate-slide-up-delay-4,
  .card-hover {
    animation: none;
    transition: none;
  }
}
```

### Step 6: Rewrite tailwind.config.ts
Keep only what's needed for `@source` and future reference. Remove `darkMode`,
`content`, `theme`, and `safelist` (all now in CSS).
```typescript
import type { Config } from 'tailwindcss';

// Minimal config retained for reference. All theme tokens and safelist patterns
// are now defined in index.css via @theme and @source inline().
const config: Config = {
  content: [],
  theme: { extend: {} },
  plugins: [],
};

export default config;
```

### Step 7: Utility class renames (from npx @tailwindcss/upgrade)
The automated tool handles most, but verify:
- `shadow` → `shadow-sm` (check if used anywhere)
- `rounded` → `rounded-sm` (check if used anywhere)
- `ring` → `outline-ring` (if using ring utility)

### Step 8: Build and verify
```bash
cd apps/frontend
npm run build          # must succeed (tsc --noEmit + vite build)
npm run typecheck      # must pass
```

### Step 9: Manual verification
- [ ] `dev` server starts without errors
- [ ] All pages load (Login, Register, Dashboard, Session Browser, Settings)
- [ ] Dark mode toggle works (class persistence via localStorage)
- [ ] Tremor components render correctly (Card, Button, Switch, Tab, etc.)
- [ ] OverlayChart renders with correct axes
- [ ] Mobile drawer opens/closes
- [ ] Skeleton loading states shimmer
- [ ] Focus-visible indicators work
- [ ] No console errors related to Tailwind or Tremor

### Step 10: Create PR and deploy
```bash
git add -A
git commit -m "feat: migrate Tailwind CSS v3.4 → v4.3.2"
git push origin feat/tailwind-v4-migration
# Create PR, merge, deploy to production
```

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Tremor components unstyled | `@source inline(...)` shim covers all Tremor utility classes |
| Missing utility classes | `npx @tailwindcss/upgrade` handles 90%+ of renames; manual review catches rest |
| CSS cascade conflicts | `@custom-variant dark` ensures `.dark` class triggers overrides correctly |
| Build failure | Typecheck + build are verification gates before PR |
| Production regression | Manual visual QA on all pages before deploy |

## Rollback Plan
If critical issues arise post-deploy:
1. Revert to `development` branch (last known good)
2. All changes are in frontend only — no DB or backend impact
3. CSS and config changes are easily reversible
