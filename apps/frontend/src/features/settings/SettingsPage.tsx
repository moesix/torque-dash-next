import { useState, useEffect } from 'react';
import { Card, Text, Title, Switch } from '@tremor/react';
import { getSettings, updateSettings } from '@/lib/api';

export default function SettingsPage() {
  const [disableRegistration, setDisableRegistration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => setDisableRegistration(s.disableRegistration))
      .catch(() => setError('Failed to load settings.'));
  }, []);

  async function onToggle(next: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const s = await updateSettings(next);
      setDisableRegistration(s.disableRegistration);
      setSaved(true);
    } catch {
      setError('Failed to save settings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <Title>Settings</Title>
        <Text className="mt-1">Global site configuration.</Text>
      </div>
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <Text className="font-medium">Disable registration</Text>
            <Text className="mt-1 text-sm text-gray-500">
              Close public signups. The deploy-time env var DISABLE_REGISTRATION
              always wins if set to true.
            </Text>
          </div>
          <Switch
            checked={disableRegistration}
            disabled={busy}
            onChange={(checked: boolean) => onToggle(checked)}
          />
        </div>
        {error ? (
          <Text className="mt-3 text-sm text-rose-600">{error}</Text>
        ) : null}
        {saved ? (
          <Text className="mt-3 text-sm text-emerald-600">Saved.</Text>
        ) : null}
      </Card>
    </div>
  );
}
