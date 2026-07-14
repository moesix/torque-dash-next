# Plan 004: Loading skeletons & data states

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

All loading states currently show plain text ("Loading sessions...", "Loading telemetry..."). This is jarring — the UI flashes between empty, text, and content. Skeleton loaders give users a sense of structure and reduce perceived wait time. Error states are also inconsistent: some show `text-rose-600`, some show nothing.

## Current state

- `apps/frontend/src/features/sessions/SessionBrowser.tsx:19` — `<Text className="text-rose-600">` for error
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx:150-156` — `<Card><Text>Loading session…</Text></Card>`
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx:217-219` — `<Text className="mt-2">Loading telemetry…</Text>`
- `apps/frontend/src/features/auth/Login.tsx:32` — `setError('Invalid email or password.')`
- No skeleton components, no shimmer animation, no consistent error pattern

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/components/ui/Skeleton.tsx` — (new) reusable skeleton primitive
- `apps/frontend/src/components/ui/ErrorAlert.tsx` — (new) consistent error display
- `apps/frontend/src/features/sessions/SessionBrowser.tsx` — skeleton during load
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx` — skeleton during load
- `apps/frontend/src/index.css` — shimmer animation

**Out of scope:**
- Loading states for every component (chart, map already handle their own)
- Retry logic or error recovery UI

## Steps

### Step 1: Add shimmer animation to index.css

```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.skeleton {
  background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-surface) 50%, var(--bg-elevated) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 0.375rem;
}
```

**Verify**: `grep -c "skeleton" apps/frontend/src/index.css` → 1

### Step 2: Create Skeleton component

Create `apps/frontend/src/components/ui/Skeleton.tsx`:
```tsx
interface SkeletonProps {
  className?: string;
}

export default function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
```

**Verify**: file exists

### Step 3: Create ErrorAlert component

Create `apps/frontend/src/components/ui/ErrorAlert.tsx`:
```tsx
interface ErrorAlertProps {
  message: string;
  onRetry?: () => void;
}

export default function ErrorAlert({ message, onRetry }: ErrorAlertProps) {
  return (
    <div className="rounded-md bg-red-50 p-4 dark:bg-red-900/20">
      <div className="flex items-start gap-3">
        {/* Red circle with exclamation */}
        <svg className="h-5 w-5 shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="flex-1">
          <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 text-sm font-medium text-red-600 hover:text-red-500 dark:text-red-400"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Verify**: file exists

### Step 4: Add skeleton to SessionBrowser

Replace the plain "Loading sessions..." text with a skeleton table (5 rows of line skeletons).

```tsx
// Loading state:
<div className="space-y-3">
  {Array.from({ length: 5 }).map((_, i) => (
    <div key={i} className="flex items-center gap-4">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-16 ml-auto" />
    </div>
  ))}
</div>
```

**Verify**: loading state shows skeleton rows, not text

### Step 5: Add skeleton to ReplayDashboard

Replace "Loading session..." with a skeleton layout:
- Session header: title line + subtitle line
- Chart area: tall rectangle skeleton
- Map: rectangle skeleton

**Verify**: loading state shows structured skeleton

### Step 6: Full build verification

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0

## Test plan

- Slow down network (Chrome DevTools) — skeletons appear during load
- Error state — ErrorAlert shows with retry button
- Error state without retry — no button shown

## Done criteria

- [ ] Shimmer animation in `index.css`
- [ ] `Skeleton.tsx` and `ErrorAlert.tsx` created
- [ ] SessionBrowser uses skeleton during load
- [ ] ReplayDashboard uses skeleton during load
- [ ] `npx vite build` exits 0

## STOP conditions

- Skeleton animation causes performance issues on low-end devices
- Tremor Card component conflicts with skeleton styling
