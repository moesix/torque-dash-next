import { useState, useEffect } from 'react';
import { Card, Text, Title } from '@tremor/react';
import {
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  setDefaultVehicle,
} from '@/lib/api';
import type { Vehicle, UpdateVehicle } from '@/lib/types';

export default function VehicleManager() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
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
    if (!confirm('Delete this vehicle? Sessions will be unassigned.')) return;
    try {
      await deleteVehicle(id);
      await loadVehicles();
    } catch {
      setError('Failed to delete vehicle.');
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
    return <Card><Text>Loading vehicles...</Text></Card>;
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <Title>Vehicles</Title>
          <Text className="mt-1 text-sm text-gray-500 dark:text-[var(--text-muted)]">
            Manage your vehicle profiles. The default vehicle is used when Torque
            Pro doesn&rsquo;t send vehicle metadata.
          </Text>
        </div>
        <button
          type="button"
          onClick={() => { setShowAddForm(true); setEditingId(null); }}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
        >
          + Add Vehicle
        </button>
      </div>

      {error && (
        <Text className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</Text>
      )}

      {/* Add form */}
      {showAddForm && (
        <div className="mt-4 rounded border border-gray-200 p-4 dark:border-[var(--border-default)]">
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
          <Text className="text-sm text-gray-500 dark:text-[var(--text-muted)]">
            No vehicles yet. Add one to start organizing your sessions.
          </Text>
        )}
        {vehicles.map((v) => (
          <div
            key={v.id}
            className="flex items-center justify-between rounded border border-gray-200 p-3 dark:border-[var(--border-default)]"
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
                    <span className="font-medium text-gray-900 dark:text-white">
                      {v.name}
                    </span>
                    {v.isDefault && (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        Default
                      </span>
                    )}
                  </div>
                  <Text className="text-sm text-gray-500 dark:text-[var(--text-muted)]">
                    {[v.year, v.make, v.model].filter(Boolean).join(' ') || 'No details'}
                    {v.engineCc ? ` · ${v.engineCc}cc` : ''}
                  </Text>
                </div>
                <div className="flex items-center gap-1">
                  {!v.isDefault && (
                    <button
                      type="button"
                      onClick={() => handleSetDefault(v.id)}
                      className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-[var(--text-muted)] dark:hover:bg-gray-700"
                      title="Set as default"
                    >
                      ★
                    </button>
                  )}
                  <button
                    type="button"
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
                    className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-[var(--text-muted)] dark:hover:bg-gray-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(v.id)}
                    className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
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
        className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={data.make ?? ''}
          onChange={(e) => onChange({ ...data, make: e.target.value || null })}
          placeholder="Make (e.g. Honda)"
          className="rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
        />
        <input
          type="text"
          value={data.model ?? ''}
          onChange={(e) => onChange({ ...data, model: e.target.value || null })}
          placeholder="Model (e.g. Civic)"
          className="rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
        />
        <input
          type="number"
          value={data.year ?? ''}
          onChange={(e) => onChange({ ...data, year: e.target.value ? Number(e.target.value) : null })}
          placeholder="Year"
          className="rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
        />
        <input
          type="number"
          value={data.engineCc ?? ''}
          onChange={(e) => onChange({ ...data, engineCc: e.target.value ? Number(e.target.value) : null })}
          placeholder="Engine CC"
          className="rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-[var(--border-default)] dark:bg-[var(--bg-card)] dark:text-[var(--text-primary)] dark:hover:bg-[var(--bg-surface)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
