import { useState, useEffect } from 'react';
import {
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  setDefaultVehicle,
} from '@/lib/api';
import type { Vehicle, UpdateVehicle } from '@/lib/types';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import Skeleton from '@/components/ui/Skeleton';

export default function VehicleManager() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  // Vehicle queued for deletion — the ConfirmDialog target (replaces the old
  // native window.confirm). null = no delete pending.
  const [deleteTarget, setDeleteTarget] = useState<Vehicle | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [formData, setFormData] = useState<UpdateVehicle>({
    name: '',
    make: null,
    model: null,
    year: null,
    engineCc: null,
  });

  useEffect(() => {
    loadVehicles();
  }, []);

  async function loadVehicles() {
    setLoading(true);
    try {
      const data = await getVehicles();
      setVehicles(data ?? []);
    } catch {
      setError('Failed to load vehicles.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!formData.name?.trim()) {
      setError('Vehicle name is required.');
      return;
    }
    try {
      await createVehicle(formData);
      setShowAddForm(false);
      setFormData({ name: '', make: null, model: null, year: null, engineCc: null });
      await loadVehicles();
    } catch {
      setError('Failed to create vehicle.');
    }
  }

  async function handleUpdate(id: number) {
    try {
      await updateVehicle(id, formData);
      setEditingId(null);
      await loadVehicles();
    } catch {
      setError('Failed to update vehicle.');
    }
  }

  async function handleDelete(id: number) {
    setDeleting(true);
    setError(null);
    try {
      await deleteVehicle(id);
      setDeleteTarget(null);
      await loadVehicles();
    } catch {
      setError('Failed to delete vehicle.');
    } finally {
      setDeleting(false);
    }
  }

  async function handleSetDefault(id: number) {
    try {
      await setDefaultVehicle(id);
      await loadVehicles();
    } catch {
      setError('Failed to set default vehicle.');
    }
  }

  if (loading) {
    return (
      <div className="card" aria-busy="true">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-2 h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="h-11 w-28 shrink-0 rounded-lg" />
        </div>
        <div className="mt-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded border border-border p-3"
            >
              <div className="min-w-0">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-2 h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="h-8 w-40" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold leading-relaxed">Vehicles</h3>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">
            Manage your vehicle profiles. The default vehicle is used when Torque
            Pro doesn&rsquo;t send vehicle metadata.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => { setShowAddForm(true); setEditingId(null); }}
        >
          + Add Vehicle
        </Button>
      </div>

      {error && (
        <p className="mt-3 text-sm leading-relaxed text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {/* Add form */}
      {showAddForm && (
        <div className="mt-4 rounded border border-border p-4">
          <VehicleForm
            data={formData}
            onChange={setFormData}
            onSave={handleCreate}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Vehicle list */}
      <div className="mt-4 space-y-3">
        {vehicles.length === 0 && (
          <p className="text-sm leading-relaxed text-fg-muted">
            No vehicles yet. Add one to start organizing your sessions.
          </p>
        )}
        {vehicles.map((v) => (
          <div
            key={v.id}
            className="flex items-center justify-between rounded border border-border p-3"
          >
            {editingId === v.id ? (
              <VehicleForm
                data={formData}
                onChange={setFormData}
                onSave={() => handleUpdate(v.id)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-fg">
                      {v.name}
                    </span>
                    {v.isDefault && <Badge tone="ok">Default</Badge>}
                  </div>
                  <p className="text-sm leading-relaxed text-fg-muted">
                    {[v.year, v.make, v.model].filter(Boolean).join(' ') || 'No details'}
                    {v.engineCc ? ` · ${v.engineCc}cc` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {!v.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSetDefault(v.id)}
                      className="text-fg-muted"
                      title="Set as default"
                      aria-label={`Set ${v.name} as default vehicle`}
                    >
                      ★
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingId(v.id);
                      setFormData({
                        name: v.name,
                        make: v.make,
                        model: v.model,
                        year: v.year,
                        engineCc: v.engineCc,
                      });
                    }}
                    className="text-fg-muted"
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(v)}
                    className="text-red-500 hover:text-red-600"
                  >
                    Delete
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Delete confirmation — replaces the old native window.confirm */}
      {deleteTarget && (
        <ConfirmDialog
          open
          busy={deleting}
          title="Delete vehicle?"
          description={`${deleteTarget.name} will be deleted and its sessions unassigned. This cannot be undone.`}
          confirmLabel="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget.id)}
        />
      )}
    </div>
  );
}

/** Inline form for creating/editing a vehicle. */
function VehicleForm({
  data,
  onChange,
  onSave,
  onCancel,
}: {
  data: UpdateVehicle;
  onChange: (d: UpdateVehicle) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <input
        type="text"
        value={data.name ?? ''}
        onChange={(e) => onChange({ ...data, name: e.target.value })}
        placeholder="Vehicle name (e.g. My Civic)"
        className="w-full rounded border border-border bg-surface-card px-3 py-2 text-sm text-fg"
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={data.make ?? ''}
          onChange={(e) => onChange({ ...data, make: e.target.value || null })}
          placeholder="Make (e.g. Honda)"
          className="rounded border border-border bg-surface-card px-3 py-2 text-sm text-fg"
        />
        <input
          type="text"
          value={data.model ?? ''}
          onChange={(e) => onChange({ ...data, model: e.target.value || null })}
          placeholder="Model (e.g. Civic)"
          className="rounded border border-border bg-surface-card px-3 py-2 text-sm text-fg"
        />
        <input
          type="number"
          value={data.year ?? ''}
          onChange={(e) => onChange({ ...data, year: e.target.value ? Number(e.target.value) : null })}
          placeholder="Year"
          className="rounded border border-border bg-surface-card px-3 py-2 text-sm text-fg"
        />
        <input
          type="number"
          value={data.engineCc ?? ''}
          onChange={(e) => onChange({ ...data, engineCc: e.target.value ? Number(e.target.value) : null })}
          placeholder="Engine CC"
          className="rounded border border-border bg-surface-card px-3 py-2 text-sm text-fg"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-xs hover:bg-accent-hover active:translate-y-px transition min-h-[44px] inline-flex items-center justify-center"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border bg-surface-card px-4 py-2 text-sm font-medium text-fg-secondary shadow-xs hover:bg-surface-elevated hover:text-fg transition min-h-[44px] inline-flex items-center justify-center"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
