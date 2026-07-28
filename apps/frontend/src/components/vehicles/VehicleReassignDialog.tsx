import { useEffect, useRef } from 'react';
import type { Vehicle } from '@/lib/types';

interface Props {
  vehicles: Vehicle[];
  currentVehicleId: number | null | undefined;
  onReassign: (vehicleId: number | null) => void;
  onClose: () => void;
}

export default function VehicleReassignDialog({
  vehicles,
  currentVehicleId,
  onReassign,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

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
          onClick={() => onReassign(null)}
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
            onClick={() => onReassign(v.id)}
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
