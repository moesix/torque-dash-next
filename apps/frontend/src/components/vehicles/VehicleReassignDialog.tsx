import { useEffect, useRef, useState } from 'react';
import type { Vehicle } from '@/lib/types';

interface Props {
  vehicles: Vehicle[];
  currentVehicleId: number | null | undefined;
  onReassign: (vehicleId: number | null) => void | Promise<void>;
  onClose: () => void;
  /** Optional notifier fired when a reassignment attempt fails. The dialog
   *  renders the error itself (see below) and stays open so the user can
   *  retry; parents may use this to surface the failure elsewhere too. */
  onError?: (message: string) => void;
}

export default function VehicleReassignDialog({
  vehicles,
  currentVehicleId,
  onReassign,
  onClose,
  onError,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  /** Await the parent's reassignment, then close only on success. On failure
   *  the dialog shows the error inline and stays open for a retry. */
  async function handleSelect(vehicleId: number | null) {
    try {
      setError(null);
      await onReassign(vehicleId);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to reassign vehicle.';
      setError(message);
      onError?.(message);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="fixed inset-0 z-50 m-auto w-full max-w-sm rounded-lg border bg-white p-6 shadow-xl dark:border-[var(--border-strong)] dark:bg-[var(--bg-card)]"
    >
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
        Reassign Vehicle
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-[var(--text-muted)]">
        Choose which vehicle this session belongs to.
      </p>
      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={() => void handleSelect(null)}
          className={`w-full rounded border px-4 py-2 text-left text-sm hover:bg-gray-50 dark:border-[var(--border-default)] dark:hover:bg-[var(--bg-surface)] ${
            currentVehicleId == null
              ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-900/20'
              : ''
          }`}
        >
          <span className="text-gray-700 dark:text-[var(--text-secondary)]">Unassigned</span>
        </button>
        {vehicles.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => void handleSelect(v.id)}
            className={`w-full rounded border px-4 py-2 text-left text-sm hover:bg-gray-50 dark:border-[var(--border-default)] dark:hover:bg-[var(--bg-surface)] ${
              currentVehicleId === v.id
                ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-900/20'
                : ''
            }`}
          >
            <span className="font-medium text-gray-900 dark:text-white">{v.name}</span>
            <span className="ml-2 text-gray-500 dark:text-[var(--text-muted)]">
              {[v.year, v.make, v.model].filter(Boolean).join(' ')}
            </span>
          </button>
        ))}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-3 text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded border bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-[var(--border-default)] dark:bg-[var(--bg-card)] dark:text-[var(--text-primary)] dark:hover:bg-[var(--bg-surface)]"
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}
