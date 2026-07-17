import { useState } from 'react';
import { Card, Text } from '@tremor/react';
import { updateLlmSettings } from '@/lib/api';
import type { Settings } from '@/lib/types';

interface Props {
  settings: Settings;
  onUpdate: (settings: Settings) => void;
}

export default function VehicleCard({ settings, onUpdate }: Props) {
  const [make, setMake] = useState(settings.vehicleMake || '');
  const [model, setModel] = useState(settings.vehicleModel || '');
  const [year, setYear] = useState(settings.vehicleYear?.toString() || '');
  const [cc, setCc] = useState(settings.engineCc?.toString() || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateLlmSettings({
        vehicleMake: make || null,
        vehicleModel: model || null,
        vehicleYear: year ? parseInt(year) : null,
        engineCc: cc ? parseInt(cc) : null,
      });
      onUpdate(updated);
      setSaved(true);
    } catch {
      setError('Failed to save vehicle info.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <Text className="font-medium">Vehicle Information</Text>
          <Text className="mt-1 text-sm text-gray-500 dark:text-[var(--text-muted)]">
            Optional. Providing vehicle details helps the AI give more
            relevant analysis (e.g. expected RPM ranges for your engine).
          </Text>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Text className="text-sm font-medium mb-1">Make</Text>
            <input
              type="text"
              value={make}
              onChange={(e) => setMake(e.target.value)}
              placeholder="e.g. Toyota"
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            />
          </div>
          <div>
            <Text className="text-sm font-medium mb-1">Model</Text>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. Corolla"
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            />
          </div>
          <div>
            <Text className="text-sm font-medium mb-1">Year</Text>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="e.g. 2019"
              min="1900"
              max="2099"
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            />
          </div>
          <div>
            <Text className="text-sm font-medium mb-1">Engine CC</Text>
            <input
              type="number"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="e.g. 1800"
              min="50"
              max="20000"
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors dark:bg-indigo-500 dark:hover:bg-indigo-600"
        >
          {busy ? 'Saving...' : 'Save Vehicle Info'}
        </button>

        {saved && <Text className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</Text>}
        {error && <Text className="text-sm text-rose-600 dark:text-rose-400">{error}</Text>}
      </div>
    </Card>
  );
}
