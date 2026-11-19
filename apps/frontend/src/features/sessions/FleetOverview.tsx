import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getFleetOverview } from '@/lib/api';
import type { FleetRow } from '@/lib/types';
import { useUnits } from '@/app/unitSystem';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';

/** Selectable activity window. The server clamps to 1..365 regardless. */
const DAY_OPTIONS = [30, 90, 180, 365];

/** Where a row's click through lands: the session browser filtered to that
 *  vehicle. The Unassigned bucket has no id, so it opens the unfiltered list. */
function rowHref(row: FleetRow): string {
  return row.vehicleId == null ? '/' : `/?vehicleId=${row.vehicleId}`;
}

function vehicleLabel(row: FleetRow): string {
  const details = [row.make, row.model].filter(Boolean).join(' ');
  return details || '—';
}

/**
 * Fleet overview (Plan 021, DIR-06): one row per vehicle with its session
 * count, last activity, and peak RPM/speed over the selected window. The data
 * comes from the denormalized Sessions summary columns via
 * `GET /api/vehicles/overview` — no per-vehicle requests, no Logs scans.
 *
 * Maxima are rendered through `useUnits()`: stored speed is km/h, so the US/UK
 * preference shows mph; RPM is unitless.
 */
export default function FleetOverview() {
  const navigate = useNavigate();
  const { fmt } = useUnits();
  const [days, setDays] = useState(90);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['fleet', days],
    queryFn: () => getFleetOverview(days),
  });
  const rows: FleetRow[] = data ?? [];

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold leading-relaxed">Fleet overview</h3>
          <p className="text-sm leading-relaxed">
            Activity and peak telemetry per vehicle. Select a vehicle to see its sessions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="fleet-window" className="text-sm text-fg-secondary">
            Window:
          </label>
          <select
            id="fleet-window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="min-h-[44px] rounded border border-border bg-surface-card px-3 py-2.5 text-sm text-fg"
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="mt-4">
          <ErrorAlert
            message="Failed to load the fleet overview. You may need to sign in again."
            onRetry={() => void refetch()}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border-faint bg-surface-elevated p-4">
          <p className="font-medium text-fg">No vehicles yet</p>
          <p className="mt-1 text-sm text-fg-secondary">
            Define a vehicle in Settings, then assign sessions to it to compare activity here.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-fg-muted">
                  Vehicle
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-fg-muted">
                  Sessions
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-fg-muted">
                  Last activity
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-fg-muted">
                  Max RPM
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-fg-muted">
                  Max speed
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-faint">
              {rows.map((row) => {
                const href = rowHref(row);
                const key = row.vehicleId ?? 'unassigned';
                return (
                  <tr
                    key={key}
                    role="button"
                    tabIndex={0}
                    aria-label={`Vehicle: ${row.name}`}
                    onClick={() => navigate(href)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(href);
                      }
                    }}
                    className="card-hover cursor-pointer hover:bg-surface-elevated"
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-fg">{row.name}</span>
                      <span className="ml-2 text-xs text-fg-muted">{vehicleLabel(row)}</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{row.sessionCount}</td>
                    <td className="px-4 py-2.5">
                      {row.lastActivityAt ? new Date(row.lastActivityAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {row.maxRpm != null ? Math.round(row.maxRpm).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {row.maxSpeed != null ? fmt(row.maxSpeed, 'km/h', { digits: 0 }).text : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
