import { useEffect, useState } from 'react';
import { getVersion } from '@/lib/api';

/**
 * Shared version-badge hook for the app chrome (AppShell sidebar and the
 * MobileDrawer, which mount together). Both used to call `getVersion()` in
 * their own mount effects, producing two /api/version requests per authed
 * load — this hook deduplicates them with a module-level memoized promise:
 * the first subscriber triggers the fetch, later subscribers reuse it.
 *
 * Failures are silent (resolves to an empty string), matching the previous
 * inline `.catch(() => {})` behaviour — the badge simply does not render.
 */
let versionPromise: Promise<string> | null = null;

function fetchVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = getVersion()
      .then((v) => v.version)
      .catch(() => '');
  }
  return versionPromise;
}

export function useVersion(): { version: string } {
  const [version, setVersion] = useState('');

  useEffect(() => {
    let alive = true;
    fetchVersion().then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { version };
}
