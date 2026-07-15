# Plan 010: Replay Dashboard Bug Fixes

## Context

User reported 5 bugs on the production site (torque.automata.my) after testing
the replay dashboard. All issues are in the frontend telemetry visualization
components.

---

## Bug 1: React removeChild error when clearing/re-selecting metrics

**Symptom:** `Failed to execute 'removeChild' on 'Node'` crash when clearing
all metrics and re-selecting one.

**Root Cause:** `OverlayChart.tsx:284-295` renders two structurally different
JSX trees based on `sources.length`. When empty, it renders a `<div>` with a
`<span>` child. When non-empty, it renders a different `<div>` (no child, for
ECharts). React cannot reconcile these because ECharts has claimed ownership of
the DOM node, causing the removeChild error.

**File:** `apps/frontend/src/components/charts/OverlayChart.tsx`

**Fix:** Always render the same container div. Show the placeholder message
conditionally inside it:

```tsx
// Replace lines 284-295 with:
return (
  <div ref={containerRef} className="h-56 w-full lg:h-72">
    {sources.length === 0 && (
      <span className="flex h-full items-center justify-center text-sm text-gray-400">
        Select metrics to display
      </span>
    )}
  </div>
);
```

This keeps a single stable DOM element for ECharts. React only manages the
inner `<span>` child.

---

## Bug 2: "Coolant 2" should be "Coolant (F)"

**Symptom:** PID decoder labels `kff1007` as "Coolant 2" when it should be
"Coolant (F)" since it's the Fahrenheit variant.

**Root Cause:** `pidDecode.ts:32` entry:
```ts
kff1007: { full: 'Engine Coolant Temp (ECT)', short: 'Coolant 2', unit: '°C' },
```
The unit is also wrong — it should be `°F`.

**File:** `apps/frontend/src/lib/pidDecode.ts`

**Fix:**
```ts
kff1007: { full: 'Engine Coolant Temperature (F)', short: 'Coolant (F)', unit: '°F' },
```

---

## Bug 3: Gauge text too dark in dark mode

**Symptom:** SVG ring gauge text (value + unit) is nearly invisible in dark
mode because fill colors are hardcoded to dark grays.

**Root Cause:** Both `SessionSummaryCard.tsx:63-82` and `GaugeTile.tsx:53-71`
use hardcoded `fill="#111827"` (near-black) and `fill="#6b7280"` (medium gray)
on SVG `<text>` elements.

**Files:**
- `apps/frontend/src/components/charts/SessionSummaryCard.tsx:63-82`
- `apps/frontend/src/components/charts/GaugeTile.tsx:53-71`

**Fix:** Replace inline `fill` with Tailwind dark mode classes:

For `SessionSummaryCard.tsx` RingGauge (line 63 and 74):
```tsx
<text x="50" y="46" textAnchor="middle" fontSize="16" fontWeight="700"
      className="fill-gray-900 dark:fill-gray-100">
  {display}
</text>
<text x="50" y="62" textAnchor="middle" fontSize="9"
      className="fill-gray-500 dark:fill-gray-400">
  {unit.trim()}
</text>
```

For `GaugeTile.tsx` (line 53 and 63):
```tsx
<text x="70" y="66" textAnchor="middle" fontSize="22" fontWeight="700"
      className="fill-gray-900 dark:fill-gray-100">
  {display}
</text>
<text x="70" y="88" textAnchor="middle" fontSize="12"
      className="fill-gray-500 dark:fill-gray-400">
  {unit.trim()}
</text>
```

Also fix the background ring stroke for dark mode in both files:
```tsx
// Background ring — change stroke="#e5e7eb" to:
className="stroke-gray-200 dark:stroke-gray-700"
```

---

## Bug 4: Max Coolant and Max RPM show 0

**Symptom:** The "Max RPM" and "Max Coolant" values in the Session Summary
row display as 0 instead of the actual peak values.

**Root Cause:** In `ReplayDashboard.tsx:135-149`, the max calculations don't
use `coerceScalar`:

```tsx
// Line 135 — RPM: raw access
const maxRpm = useMemo(() => safeMax(frames.map((f) => f.engineRpm)), [frames]);

// Lines 140-148 — Coolant: typeof check rejects strings
const maxCoolant = useMemo(
  () => safeMax(frames.map((f) => {
    const raw = f.values?.k5;
    return typeof raw === 'number' ? raw : null;
  })),
  [frames],
);
```

If `f.engineRpm` or `f.values?.k5` arrive as **strings** (e.g. `"3500"` from
JSON), the `typeof raw === 'number'` check fails and returns `null`. `safeMax`
then returns 0 because no values exceed the initial `m = 0`.

Note: The gauges themselves work because `getSeriesData` uses `coerceScalar`
which handles string→number conversion. Only the max calculations are broken.

**File:** `apps/frontend/src/features/dashboard/ReplayDashboard.tsx`

**Fix:** Use `coerceScalar` for all three max calculations:

```tsx
const maxRpm = useMemo(
  () => safeMax(frames.map((f) => coerceScalar(f.engineRpm))),
  [frames],
);
const maxSpeed = useMemo(
  () => safeMax(frames.map((f) => coerceScalar(f.vehicleSpeed))),
  [frames],
);
const maxCoolant = useMemo(
  () => safeMax(frames.map((f) => coerceScalar(f.values?.k5))),
  [frames],
);
```

`coerceScalar` is already imported from `pidDecode.ts`.

---

## Bug 5: Chart squashed with many metrics selected

**Symptom:** The time series graph becomes vertically squashed when many
metrics are selected.

**Root Cause:** In `OverlayChart.tsx:175`, each right-side y-axis gets an
offset of 60px. With 4 visible axes: `rightMargin = min(180, 24 + 180) =
180px`. This consumes 180px of horizontal space, leaving less room for the
plot. Combined with `containLabel: true` adding extra padding, the chart area
shrinks vertically.

**File:** `apps/frontend/src/components/charts/OverlayChart.tsx`

**Fix:** Reduce the axis offset from 60 to 45 and adjust the right margin:

```tsx
// Line 175 — reduce offset:
opt.offset = 45 * (axisIdx - 1);

// Lines 188-191 — match reduced offset:
const rightMargin = Math.min(150, 24 + Math.max(0, visibleAxisCount - 1) * 45);
```

This saves 45px per extra axis, giving the chart plot area more breathing room.

---

## Files Affected

| File | Bugs |
|------|------|
| `apps/frontend/src/components/charts/OverlayChart.tsx` | #1, #5 |
| `apps/frontend/src/lib/pidDecode.ts` | #2 |
| `apps/frontend/src/components/charts/SessionSummaryCard.tsx` | #3 |
| `apps/frontend/src/components/charts/GaugeTile.tsx` | #3 |
| `apps/frontend/src/features/dashboard/ReplayDashboard.tsx` | #4 |

## Verification

1. `npm run build` — must pass (tsc + vite build)
2. `npm run typecheck` — must pass
3. Manual: clear metrics → select 1 → no crash (Bug 1)
4. Manual: verify "Coolant (F)" label in metrics list (Bug 2)
5. Manual: toggle dark mode → gauge text readable (Bug 3)
6. Manual: verify Max RPM/Coolant show actual values, not 0 (Bug 4)
7. Manual: select 6+ metrics → chart not squashed (Bug 5)
