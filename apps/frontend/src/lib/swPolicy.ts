/**
 * Routing policy for the generated service worker (scripts/sw-template.js).
 *
 * Kept in a plain TS module so the decisions that matter for privacy — app
 * data (`/api/**`) is never cached, only same-origin GETs are handled — are
 * unit-testable outside the ServiceWorkerGlobalScope. The generated worker
 * mirrors this logic; keep the two in sync.
 */

/**
 * Whether the service worker should intercept a request at all.
 *
 * Non-GET requests always bypass (mutations must reach the network), as do
 * cross-origin requests and anything under `/api/` — telemetry and HTML with
 * personal data stay network-only so nothing sensitive is written to Cache
 * Storage.
 */
export function shouldHandle(url: string, method: string): boolean {
  const u = new URL(url);
  if (method !== 'GET') return false;
  if (u.origin !== location.origin) return false; // unit tests pass a fake origin via full URLs + mocked location
  if (u.pathname.startsWith('/api/')) return false; // network-only app data
  return true;
}

/** Navigation requests get network-first with the cached app shell as fallback. */
export function isNavigation(mode: string): boolean {
  return mode === 'navigate';
}
