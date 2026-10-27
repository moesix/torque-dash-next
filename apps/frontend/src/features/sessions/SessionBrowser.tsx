import { useState, useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getSessions, getVehicles } from '@/lib/api';
import type { PaginatedSessions } from '@/lib/api';
import type { Session, Vehicle } from '@/lib/types';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import Button from '@/components/ui/Button';
import SessionTable from '@/components/tables/SessionTable';

/** Flatten accumulated pages, dropping rows already seen so an offset window
 *  that repeats a session can't produce duplicate React keys (or a drifting
 *  "N of total" label). First occurrence wins; page order is preserved. */
function flattenUniqueSessions(pages: Array<PaginatedSessions | undefined>): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  for (const page of pages) {
    for (const session of page?.sessions ?? []) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      out.push(session);
    }
  }
  return out;
}

export default function SessionBrowser() {
  const limit = 50;
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  // 'none' is the Unassigned filter the API understands (vehicleId=none).
  // It must never be coerced with Number(), which turns it into NaN.
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | 'all' | 'none'>('all');

  useEffect(() => {
    getVehicles().then((v) => setVehicles(v ?? [])).catch(() => {});
  }, []);

  // Pages accumulate: each "Load More" appends a page instead of replacing the
  // table. The vehicle filter is part of the query key, so switching vehicles
  // starts a fresh key at page 0 (no manual offset reset needed).
  const q = useInfiniteQuery({
    queryKey: ['sessions', selectedVehicleId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getSessions(limit, pageParam, selectedVehicleId === 'all' ? null : selectedVehicleId),
    getNextPageParam: (last, all) => {
      // Stop when the server returns an empty/duplicate window: documents that
      // repeat the last offset would otherwise page forever. `got` is the rows
      // this page actually added over the previously loaded windows.
      const before = all.slice(0, -1).flatMap((p) => p?.sessions ?? []).length;
      const loaded = all.flatMap((p) => p?.sessions ?? []).length;
      const got = loaded - before;
      return got > 0 && loaded < (last?.total ?? 0) ? loaded : undefined;
    },
  });

  const { isLoading, isError, refetch } = q;
  // refetch drives the error-retry button — no window.location.reload(), which
  // would nuke SPA state just to re-run the query.
  const sessions = flattenUniqueSessions(q.data?.pages ?? []);
  const pages = q.data?.pages ?? [];
  const total = pages.length > 0 ? (pages[pages.length - 1]?.total ?? 0) : 0;
  const hasMore = q.hasNextPage;
  // A failed NEXT page keeps the pages already on screen; only a failure with
  // no data at all deserves to replace the table with the full error card.
  const nextPageError = isError && Boolean(q.data);

  if (isLoading) {
    return (
      <div className="card">
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

  if (isError && !q.data) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold leading-relaxed">Your Sessions</h3>
        <p className="text-sm leading-relaxed">Select a session to replay its telemetry.</p>
        <div className="mt-4">
          <ErrorAlert
            message="Failed to load sessions. You may need to sign in again."
            onRetry={() => void refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="session-card card">
      <h3 className="text-lg font-semibold leading-relaxed">Your Sessions</h3>
      <p className="text-sm leading-relaxed">Select a session to replay its telemetry.</p>
      {vehicles.length > 0 && (
        <div className="mt-4 flex items-center gap-2">
          <label htmlFor="vehicle-filter" className="text-sm text-fg-secondary">
            Filter by vehicle:
          </label>
          <select
            id="vehicle-filter"
            value={selectedVehicleId}
            onChange={(e) => {
              const value = e.target.value;
              setSelectedVehicleId(value === 'all' || value === 'none' ? value : Number(value));
            }}
            className="rounded border border-border bg-surface-card px-3 py-2.5 min-h-[44px] text-sm text-fg"
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
        <div className="mt-4 overflow-x-auto">
          <SessionTable sessions={sessions} />
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
              className="mt-4"
            >
              Load More ({sessions.length} of {total})
            </Button>
          )}
        </div>
      ) : null}
      {nextPageError ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-red-50 p-3 dark:bg-red-900/20">
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            Couldn&apos;t load more sessions.
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {!isLoading && total === 0 ? <EmptyState /> : null}
    </div>
  );
}

/**
 * Composed getting-started card for a fresh install: one-line explanation,
 * the exact upload URL shape, and the pointer to the upload-token card in
 * Settings. Hidden in print (it's guidance, not report content).
 */
function EmptyState() {
  return (
    <div className="print:hidden mt-4 rounded-lg border border-border-faint bg-surface-elevated p-4 md:p-6">
      <p className="font-medium text-fg">No sessions yet</p>
      <p className="mt-1 text-sm text-fg-secondary">
        Sessions arrive when your Torque Pro app uploads telemetry. Point it at:
      </p>
      <code className="mt-2 block break-all rounded border border-border bg-surface-card px-3 py-2 text-xs font-mono text-fg">
        https://&lt;your-host&gt;/api/upload?eml=&lt;your-email&gt;&amp;session=1&amp;id=1
      </code>
      <p className="mt-2 text-xs text-fg-muted">
        If an upload token is configured, generate one under Settings →
        Upload API Token, then send it as a{' '}
        <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>{' '}
        header.
      </p>
    </div>
  );
}
