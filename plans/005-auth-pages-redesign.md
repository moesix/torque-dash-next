# Plan 005: Auth pages redesign

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 001 (design tokens + typography)
- **Category**: direction
- **Planned at**: commit `e6fa71f`, 2026-07-14

## Why this matters

The Login and Register pages are the first thing users see. Currently they're a plain centered Tremor Card with system fonts, no branding, and a gray background. For a telemetry app, this should feel like entering a cockpit — technical, sharp, and purposeful.

## Current state

- `apps/frontend/src/features/auth/Login.tsx:36` — `<div className="flex min-h-full items-center justify-center bg-gray-50 p-4">`
- `apps/frontend/src/features/auth/Login.tsx:37-84` — Tremor Card with Title, Text, form, Button
- `apps/frontend/src/features/auth/Register.tsx` — identical structure
- No logo on auth pages
- No visual interest — just a card on gray

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `cd apps/frontend && npx tsc --noEmit` | exit 0 |
| Build | `cd apps/frontend && npx vite build` | exit 0 |

## Scope

**In scope:**
- `apps/frontend/src/features/auth/Login.tsx` — visual redesign
- `apps/frontend/src/features/auth/Register.tsx` — matching redesign

**Out of scope:**
- Auth logic changes
- OAuth/social login
- Password reset flow

## Steps

### Step 1: Redesign Login page

Replace the centered card with a split layout: left side has branding/visual, right side has the form. On mobile, stack vertically.

**Target shape:**
```tsx
return (
  <div className="flex min-h-full">
    {/* Left panel — branding (hidden on mobile) */}
    <div className="hidden w-1/2 items-center justify-center bg-blue-600 p-12 lg:flex">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 h-16 w-16 rounded-2xl bg-white/20 backdrop-blur" />
        <h1 className="text-3xl font-bold text-white" style={{ fontFamily: 'var(--font-display)' }}>
          TorqueDash
        </h1>
        <p className="mt-3 text-lg text-blue-100">
          Real-time vehicle telemetry replay and analysis.
        </p>
      </div>
    </div>

    {/* Right panel — form */}
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Mobile-only logo */}
        <div className="mb-8 text-center lg:hidden">
          <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white" style={{ fontFamily: 'var(--font-display)' }}>
            TorqueDash
          </h1>
        </div>

        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Sign in</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Access your TorqueDash sessions.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm
                focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
                dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm
                focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20
                dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white
              hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
              disabled:opacity-50 dark:focus:ring-offset-gray-900"
          >
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {registrationDisabled ? (
            'New account signups are disabled.'
          ) : (
            <>
              No account?{' '}
              <a className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400" href="/register">
                Register
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  </div>
);
```

**Verify**: Login page shows split layout on desktop, stacked on mobile

### Step 2: Redesign Register page

Mirror the Login page structure with "Create account" heading and matching styling.

**Verify**: Register page matches Login visual style

### Step 3: Full build verification

**Verify**:
- `npx tsc --noEmit` → exit 0
- `npx vite build` → exit 0
- Login and Register pages render correctly in light and dark mode
- Mobile layout works (stacked, logo visible)

## Test plan

- Login page at 1440px — split layout visible
- Login page at 375px — stacked layout, mobile logo visible
- Register page — matches Login style
- Dark mode — both pages look correct
- Form submission — error states display correctly

## Done criteria

- [ ] Login.tsx has split layout with branding panel
- [ ] Register.tsx matches Login style
- [ ] Mobile-responsive (stacked layout below lg)
- [ ] Dark mode variants included
- [ ] `npx vite build` exits 0

## STOP conditions

- Tremor Card/Button components conflict with custom styling
- Split layout causes routing issues
