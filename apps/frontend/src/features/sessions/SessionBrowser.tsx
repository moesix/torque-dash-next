import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSessions, getVehicles } from '@/lib/api';
import type { Vehicle } from '@/lib/types';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import SessionTable from '@/components/tables/SessionTable';

export default function SessionBrowser() {
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | 'all'>('all');

  useEffect(() => {
    getVehicles().then((v) => setVehicles(v ?? [])).catch(() => {});
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['sessions', offset, selectedVehicleId],
    queryFn: () => getSessions(limit, offset, selectedVehicleId === 'all' ? null : selectedVehicleId),
  });

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const hasMore = offset + limit < total;

  if (isLoading) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
        <h3 className="text-lg font-semibold leading-relaxed">Your Sessions</h3>
        <p className="text-sm leading-relaxed">Select a session to replay its telemetry.</p>
        <div className="mt-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16 ml-auto" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
        <h3 className="text-lg font-semibold leading-relaxed">Your Sessions</h3>
        <p className="text-sm leading-relaxed">Select a session to replay its telemetry.</p>
        <div className="mt-4">
          <ErrorAlert
            message="Failed to load sessions. You may need to sign in again."
            onRetry={() => window.location.reload()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="session-card rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
      <h3 className="text-lg font-semibold leading-relaxed">Your Sessions</h3>
      <p className="text-sm leading-relaxed">Select a session to replay its telemetry.</p>
      {vehicles.length > 0 && (
        <div className="mt-4 flex items-center gap-2">
          <label htmlFor="vehicle-filter" className="text-sm text-gray-600 dark:text-[var(--text-secondary)]">
            Filter by vehicle:
          </label>
          <select
            id="vehicle-filter"
            value={selectedVehicleId}
            onChange={(e) => {
              setSelectedVehicleId(e.target.value === 'all' ? 'all' : Number(e.target.value));
              setOffset(0);
            }}
            className="rounded border bg-white px-3 py-1.5 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
          >
            <option value="all">All vehicles</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
            <option value="none">Unassigned</option>
          </select>
        </div>
      )}
      {sessions.length > 0 ? (
        <div className="mt-4">
          <SessionTable sessions={sessions} />
          {hasMore && (
            <button
              onClick={() => setOffset((prev) => prev + limit)}
              className="mt-4 rounded bg-gray-100 px-4 py-2 text-sm hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
            >
              Load More ({sessions.length} of {total})
            </button>
          )}
        </div>
      ) : null}
      {!isLoading && total === 0 ? (
        <p className="mt-4 text-sm leading-relaxed">No sessions yet.</p>
      ) : null}
    </div>
  );
}
