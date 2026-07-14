# Plan 008: Micro-interactions & page transitions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 001 (design tokens)
- **Category**: direction
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

The app has zero CSS animations and zero page transitions. Every navigation is an instant swap. Motion gives users spatial orientation (where did I go?), feedback (did that work?), and delight (this feels polished). The frontend-design skill emphasizes: "one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions."

## Current state

- ECharts animation explicitly disabled (`animation: false`)
- 3 CSS transitions: pencil icon opacity, button hover colors
- No `@keyframes` anywhere
- No page transitions
- No loading→content transitions
- No hover states on cards
- No scroll-triggered animations

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/index.css` — utility animation classes
- `apps/frontend/src/components/layout/AppShell.tsx` — page transition wrapper
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx` — staggered card reveal
- `apps/frontend/src/components/charts/SessionSummaryCard.tsx` — gauge entrance animation
- `apps/frontend/src/features/auth/Login.tsx` — card entrance
- `apps/frontend/src/components/tables/SessionTable.tsx` — row hover lift

**Out of scope:**
- ECharts chart animations (intentionally disabled for performance)
- Scroll-triggered animations (Intersection Observer is future work)
- Complex physics-based animations
- Framer Motion (CSS-only approach)

## Steps

### Step 1: Add animation utility classes to index.css

```css
/* Page transition */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Staggered reveal */
@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Gauge ring draw */
@keyframes ringDraw {
  from { stroke-dashoffset: var(--ring-circumference, 283); }
  to { stroke-dashoffset: var(--ring-target, 0); }
}

/* Subtle card hover */
@keyframes subtleLift {
  from { box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1); }
  to { box-shadow: 0 4px 12px 0 rgb(0 0 0 / 0.15); }
}

/* Utility classes */
.animate-fade-in {
  animation: fadeIn 0.3s ease-out both;
}

.animate-slide-up {
  animation: slideUp 0.4s ease-out both;
}

.animate-slide-up-delay-1 {
  animation: slideUp 0.4s ease-out 0.1s both;
}

.animate-slide-up-delay-2 {
  animation: slideUp 0.4s ease-out 0.2s both;
}

.animate-slide-up-delay-3 {
  animation: slideUp 0.4s ease-out 0.3s both;
}

.animate-slide-up-delay-4 {
  animation: slideUp 0.4s ease-out 0.4s both;
}

.card-hover {
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
.card-hover:hover {
  box-shadow: 0 4px 12px 0 rgb(0 0 0 / 0.12);
  transform: translateY(-1px);
}

/* Ring gauge animation */
.animate-ring-draw {
  animation: ringDraw 0.8s ease-out both;
}

/* Reduced motion preference */
@media (prefers-reduced-motion: reduce) {
  .animate-fade-in,
  .animate-slide-up,
  .animate-slide-up-delay-1,
  .animate-slide-up-delay-2,
  .animate-slide-up-delay-3,
  .animate-slide-up-delay-4,
  .animate-ring-draw,
  .card-hover {
    animation: none;
    transition: none;
  }
}
```

**Verify**: `grep -c "prefers-reduced-motion" apps/frontend/src/index.css` → 1

### Step 2: Add page transition to AppShell

Wrap the `<Outlet />` in a transition container:

```tsx
<main id="main-content" className="min-h-0 flex-1 overflow-auto p-4">
  <div className="animate-fade-in" key={location.pathname}>
    <Outlet />
  </div>
</main>
```

Import `useLocation` from react-router-dom.

**Verify**: navigating between pages shows a subtle fade-in

### Step 3: Add staggered reveal to ReplayDashboard

Apply staggered animation classes to the dashboard cards:

```tsx
<div className="space-y-4">
  <div className="animate-slide-up">session banner</div>
  <div className="animate-slide-up-delay-1">controls + gauges</div>
  <div className="animate-slide-up-delay-2">chart + PID panel</div>
  <div className="animate-slide-up-delay-3">GPS map + metrics</div>
</div>
```

**Verify**: cards slide up in sequence on page load

### Step 4: Animate gauge rings in SessionSummaryCard

Add the ring draw animation to the SVG gauge circles:

```tsx
<circle
  className="animate-ring-draw"
  style={{
    '--ring-circumference': circumference,
    '--ring-target': circumference - targetDash,
    strokeDasharray: circumference,
    strokeDashoffset: circumference,
    animationDelay: `${index * 0.15}s`,
  } as React.CSSProperties}
  ...
/>
```

**Verify**: gauge rings animate from 0 to value on load

### Step 5: Add card hover to SessionTable rows

Add `card-hover` class to table rows:

```tsx
<tr className="group cursor-pointer border-b card-hover" ...>
```

**Verify**: rows lift slightly on hover

### Step 6: Add entrance animation to Login card

Wrap the login form in an animated container:

```tsx
<div className="animate-slide-up w-full max-w-sm">
  {/* form content */}
</div>
```

**Verify**: Login card slides up on load

### Step 7: Full build verification

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0
- Animations play on page load
- `prefers-reduced-motion: reduce` disables all animations

## Test plan

- Navigate between pages — fade transition plays
- Open ReplayDashboard — cards stagger in sequence
- Watch gauges — rings animate from 0 to value
- Hover session rows — subtle lift effect
- Enable `prefers-reduced-motion` in OS — no animations play
- Performance — no jank during animations (check with DevTools)

## Done criteria

- [ ] Animation utility classes in index.css
- [ ] `prefers-reduced-motion` media query disables animations
- [ ] Page transition fade on navigation
- [ ] Staggered card reveal on ReplayDashboard
- [ ] Gauge ring draw animation
- [ ] Card hover effect on SessionTable rows
- [ ] Login card entrance animation
- [ ] `npx vite build` exits 0

## STOP conditions

- Animations cause jank on low-end devices (test with CPU throttling)
- `prefers-reduced-motion` doesn't work
- Ring animation conflicts with real-time gauge value updates
- Page transition causes React state loss
