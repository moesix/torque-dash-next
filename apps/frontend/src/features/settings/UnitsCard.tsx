import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, getPreferences } from '@/lib/api';
import type { UnitSystem } from '@/lib/types';
import { format } from '@/lib/units';
import { useUnits } from '@/app/unitSystem';

/**
 * Per-user unit-system selector (plan 045). Rendered for ALL users — the
 * preference lives on `Users`, not the admin-only Settings singleton.
 *
 * The first option saves `null` (inherit DEFAULT_UNIT_SYSTEM); its label
 * reflects the resolved server default from GET /api/users/preferences.
 */
const SYSTEM_LABELS: Record<UnitSystem, string> = {
  metric: 'Metric (km/h, °C, kPa)',
  us: 'US customary (mph, °F, psi, US gal, MPG US)',
  uk: 'UK (mph, °C, psi, MPG UK)',
};

const SHORT_NAMES: Record<UnitSystem, string> = {
  metric: 'Metric',
  us: 'US customary',
  uk: 'UK',
};

type Choice = UnitSystem | 'inherit';

function previewFor(system: UnitSystem): string {
  const speed = format(100, 'km/h', system).text;
  const temp = format(90, '°C', system).text;
  const pressure = format(240, 'kPa', system).text;
  return `100 km/h · 90 °C · 240 kPa → ${speed} · ${temp} · ${pressure}`;
}

export default function UnitsCard() {
  const { setSystem, serverDefault } = useUnits();
  const { data } = useQuery({
    queryKey: ['preferences'],
    queryFn: getPreferences,
    staleTime: Infinity,
    retry: false,
  });

  const preference = data?.preference ?? null;
  const selected: Choice = preference ?? 'inherit';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Preview follows the *pending* selection: inherit previews with the
  // server default (what the user would actually see).
  const previewSystem: UnitSystem = selected === 'inherit' ? serverDefault : selected;

  async function choose(next: Choice) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setSystem(next === 'inherit' ? null : next);
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : 'Failed to save unit preference.',
      );
    } finally {
      setSaving(false);
    }
  }

  const options: { value: Choice; label: string }[] = [
    {
      value: 'inherit',
      label: `Server default (${SHORT_NAMES[serverDefault]})`,
    },
    { value: 'metric', label: SYSTEM_LABELS.metric },
    { value: 'us', label: SYSTEM_LABELS.us },
    { value: 'uk', label: SYSTEM_LABELS.uk },
  ];

  return (
    <div className="card">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium leading-relaxed">Units</legend>
        <p className="text-sm leading-relaxed text-gray-500 dark:text-[var(--text-muted)]">
          Display units for gauges, charts, tables and exports. Stored telemetry
          is unchanged — switching re-renders the same data.
        </p>

        <div className="space-y-2">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="unit-system"
                value={opt.value}
                checked={selected === opt.value}
                disabled={saving}
                onChange={() => void choose(opt.value)}
                className="h-4 w-4"
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>

        <p
          className="text-xs leading-relaxed text-gray-500 dark:text-[var(--text-muted)]"
          data-testid="units-preview"
        >
          {previewFor(previewSystem)}
        </p>

        {error ? (
          <p className="text-sm leading-relaxed text-rose-600 dark:text-rose-400" role="alert">
            {error}
          </p>
        ) : null}
        {saved && !error ? (
          <p className="text-sm leading-relaxed text-emerald-600 dark:text-emerald-400">
            Saved.
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
