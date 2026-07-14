# Plan 006: Replay dashboard visual polish

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 001 (design tokens), 004 (skeletons)
- **Category**: direction
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

The ReplayDashboard is the core page — where users spend 90% of their time. Currently it's a vertical stack of cards with inconsistent spacing, no visual hierarchy, and the chart feels disconnected from the gauges. The layout should guide the eye: controls → summary → chart → details.

## Current state

- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx:167` — `<div className="space-y-4">`
- Cards stacked vertically with uniform spacing — no hierarchy
- Session header card is the same visual weight as every other card
- Chart grid: `Grid numItemsLg={3}` with chart 2 cols, PID panel 1 col
- GPS map below the chart — full width
- DecodedMetricsTable at the bottom — full width

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/features/dashboard/ReplayDashboard.tsx` — layout restructure
- `apps/frontend/src/features/dashboard/PlaybackControls.tsx` — visual refinement
- `apps/frontend/src/components/charts/SessionSummaryCard.tsx` — polish gauges
- `apps/frontend/src/components/telemetry/PidTogglePanel.tsx` — visual polish
- `apps/frontend/src/components/telemetry/DecodedMetricsTable.tsx` — visual polish

**Out of scope:**
- Chart behavior changes (OverlayChart works well)
- GPS map changes (GpsTrackMap works well)
- New features

## Steps

### Step 1: Restructure dashboard layout

Restructure the vertical stack into a more intentional hierarchy:

1. **Session header** — slim banner (not a full card), just title + date on a subtle background
2. **Playback controls + SessionSummaryCard** — side by side on desktop (controls left, gauges right)
3. **Chart + PID panel** — the 2:1 grid (keep as-is, it works)
4. **GPS map + Metrics table** — side by side on desktop (map left, table right)

**Target layout structure:**
```tsx
<div className="space-y-4">
  {/* Slim session banner */}
  <div className="rounded-lg bg-white px-4 py-3 shadow-sm dark:bg-gray-800">
    <h1 className="text-lg font-semibold text-gray-900 dark:text-white" style={{ fontFamily: 'var(--font-display)' }}>
      {sessionQuery.data.name || 'Session Replay'}
    </h1>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      {date} {duration && `· ${duration}`}
    </p>
  </div>

  {/* Controls + Gauges row */}
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
    <div className="lg:col-span-2">
      <PlaybackControls frames={frames} />
    </div>
    <SessionSummaryCard ... />
  </div>

  {/* Chart + PID panel */}
  <Grid numItemsLg={3} className="gap-4">
    <Card className="lg:col-span-2">...</Card>
    <Card>...</Card>
  </Grid>

  {/* Map + Metrics */}
  <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
    <Card className="lg:col-span-2">GPS Track...</Card>
    <DecodedMetricsTable ... />
  </div>
</div>
```

**Verify**: layout has clear visual hierarchy, controls and gauges are side by side

### Step 2: Polish PlaybackControls

- Add a subtle card wrapper with `bg-white dark:bg-gray-800 rounded-lg shadow-sm p-3`
- Group related controls (play + scrubber together, speed separate)
- Add labels above speed selector
- Increase scrubber visual prominence

**Verify**: controls feel grouped and purposeful

### Step 3: Polish SessionSummaryCard

- Use `var(--font-mono)` for gauge numbers (monospace feel)
- Add subtle `bg-white dark:bg-gray-800` card background
- Ensure gauge labels use `var(--text-secondary)` for hierarchy

**Verify**: gauges match the new design token typography

### Step 4: Polish PidTogglePanel

- Add section dividers between PID categories
- Use `var(--font-mono)` for PID codes
- Add subtle hover state on rows
- Improve search input focus state

**Verify**: panel feels organized and scannable

### Step 5: Polish DecodedMetricsTable

- Use monospace font for numeric values
- Add subtle row hover
- Improve collapse/expand visual indicator
- Align numbers right for easy scanning

**Verify**: table is easy to scan, numbers align

### Step 6: Full build verification

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0
- All sections render correctly in light and dark mode
- Layout works at 375px, 768px, 1024px, 1440px

## Test plan

- Open a session with telemetry data
- Verify controls + gauges are side by side on desktop
- Verify chart + PID panel layout
- Verify map + metrics table layout
- Resize to mobile — everything stacks vertically
- Dark mode — all sections look correct

## Done criteria

- [ ] Session banner is slim (not full card weight)
- [ ] PlaybackControls and SessionSummaryCard side by side on lg+
- [ ] GPS map and DecodedMetricsTable side by side on lg+
- [ ] Monospace font used for numeric data and PID codes
- [ ] Consistent card styling across all sections
- [ ] `npx vite build` exits 0

## STOP conditions

- Tremor Grid component doesn't support the restructured layout
- Chart ResizeObserver breaks in the new grid arrangement
- Layout shifts during data loading
