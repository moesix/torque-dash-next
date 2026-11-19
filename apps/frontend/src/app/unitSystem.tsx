import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPreferences, updatePreferences } from '@/lib/api';
import type { UnitSystem, UserPreferences } from '@/lib/types';
import {
  format as formatUnit,
  type FormattedValue,
} from '@/lib/units';

/**
 * Per-user unit-system context (plan 045).
 *
 * Conversion is display-time only — no telemetry refetch is needed when the
 * preference changes. `useUnits()` deliberately works without a provider
 * (metric defaults) so isolated component tests keep rendering.
 */
export interface UnitSystemContextValue {
  /** Resolved system for rendering (user → env default → metric). */
  system: UnitSystem;
  /** Deploy-time default from DEFAULT_UNIT_SYSTEM. */
  serverDefault: UnitSystem;
  /** Raw user preference; null = inherit the server default. */
  preference: UnitSystem | null;
  /** Persist a new preference (null = inherit). Optimistic, rolls back on error. */
  setSystem: (next: UnitSystem | null) => Promise<void>;
  /** Convert + format a value bound to the current system. */
  fmt: (
    value: number | null,
    from: string,
    opts?: { digits?: number },
  ) => FormattedValue;
}

const FALLBACK_PREFS: UserPreferences = {
  unitSystem: 'metric',
  serverDefault: 'metric',
  preference: null,
};

const UnitSystemContext = createContext<UnitSystemContextValue | null>(null);

export function UnitSystemProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['preferences'],
    queryFn: getPreferences,
    staleTime: Infinity,
    retry: false,
  });
  const prefs = data ?? FALLBACK_PREFS;
  const system = prefs.unitSystem;

  const setSystem = useCallback(
    async (next: UnitSystem | null) => {
      const key = ['preferences'];
      const previous = queryClient.getQueryData<UserPreferences>(key) ?? FALLBACK_PREFS;
      const optimistic: UserPreferences = {
        unitSystem: next ?? previous.serverDefault,
        serverDefault: previous.serverDefault,
        preference: next,
      };
      queryClient.setQueryData(key, optimistic);
      try {
        const saved = await updatePreferences(next);
        if (saved) queryClient.setQueryData(key, saved);
        else queryClient.setQueryData(key, optimistic);
      } catch (err) {
        queryClient.setQueryData(key, previous);
        throw err;
      }
    },
    [queryClient],
  );

  const value = useMemo<UnitSystemContextValue>(
    () => ({
      system,
      serverDefault: prefs.serverDefault,
      preference: prefs.preference,
      setSystem,
      fmt: (value2, from, opts) => formatUnit(value2, from, system, opts),
    }),
    [system, prefs.serverDefault, prefs.preference, setSystem],
  );

  return (
    <UnitSystemContext.Provider value={value}>
      {children}
    </UnitSystemContext.Provider>
  );
}

/** Unit context with a metric fallback when no provider is mounted. */
export function useUnits(): UnitSystemContextValue {
  const ctx = useContext(UnitSystemContext);
  if (ctx) return ctx;
  return {
    system: 'metric',
    serverDefault: 'metric',
    preference: null,
    setSystem: async () => {},
    fmt: (value, from, opts) => formatUnit(value, from, 'metric', opts),
  };
}
