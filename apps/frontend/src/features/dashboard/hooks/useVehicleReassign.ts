import { useCallback, useState } from 'react';
import { getVehicles, reassignSessionVehicle } from '@/lib/api';
import type { Session, Vehicle } from '@/lib/types';
import { queryClient } from '@/app/queryClient';

/**
 * Vehicle-reassign dialog flow for the replay dashboard (moved verbatim out of
 * ReplayDashboard.tsx in plans/017 — behavior unchanged).
 *
 * Owns `vehicles`, `showReassign` and `reassignError`. Error surfacing is
 * deliberate: a failed vehicle-list load sets `reassignError` for the inline
 * message next to the trigger button; a failed reassignment is rendered inside
 * the dialog (it stays open) and mirrored into `reassignError` too.
 *
 * The dialog component itself stays in ReplayDashboard — only the state and
 * the flow moved here.
 */
export function useVehicleReassign(sessionId: string | undefined) {
  const [showReassign, setShowReassign] = useState(false);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [reassignError, setReassignError] = useState<string | null>(null);

  /** Load the vehicle list, then open the dialog (closed on load failure). */
  const openReassign = useCallback(async () => {
    if (!sessionId) return;
    setReassignError(null);
    try {
      const v = await getVehicles();
      setVehicles(v ?? []);
      setShowReassign(true);
    } catch (err) {
      setReassignError(
        err instanceof Error ? err.message : 'Failed to load vehicles.',
      );
    }
  }, [sessionId]);

  const reassign = useCallback(
    async (vehicleId: number | null) => {
      if (!sessionId) return;
      try {
        await reassignSessionVehicle(sessionId, vehicleId);
        // Patch the session query cache BEFORE the dialog closes so the
        // banner's vehicle chip reflects the assignment immediately.
        // Query key mirrors useSessionTelemetry (['session', id]).
        queryClient.setQueryData<Session | undefined>(['session', sessionId], (old) => {
          if (!old) return old;
          const assigned = vehicles.find((v) => v.id === vehicleId);
          return {
            ...old,
            vehicleId,
            vehicleName: assigned ? assigned.name : null,
          };
        });
      } catch (err) {
        // Rethrow so the dialog renders the error and stays open — it
        // awaits onReassign and only closes after this resolves.
        throw err instanceof Error
          ? err
          : new Error('Failed to reassign vehicle.');
      }
    },
    [sessionId, vehicles],
  );

  const closeReassign = useCallback(() => {
    setReassignError(null);
    setShowReassign(false);
  }, []);

  return {
    showReassign,
    vehicles,
    reassignError,
    setReassignError,
    openReassign,
    reassign,
    closeReassign,
  };
}
