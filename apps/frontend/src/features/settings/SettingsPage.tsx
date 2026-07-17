import { useState, useEffect } from 'react';
import { Card, Text, Title, Switch } from '@tremor/react';
import { getSettings, updateSettings, generateUploadToken } from '@/lib/api';
import type { Settings } from '@/lib/types';
import AiProviderCard from './AiProviderCard';
import VehicleCard from './VehicleCard';

export default function SettingsPage() {
  const [disableRegistration, setDisableRegistration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Upload API token state
  const [hasUploadApiToken, setHasUploadApiToken] = useState(false);
  const [tokenFromEnv, setTokenFromEnv] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  const [llmSettings, setLlmSettings] = useState<Settings>({
    disableRegistration: false,
    hasUploadApiToken: false,
    tokenFromEnv: false,
    hasLlmProvider: false,
    llmProvider: null,
    llmModel: null,
    llmEndpoint: null,
    hasLlmApiKey: false,
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    engineCc: null,
  });

  useEffect(() => {
    getSettings()
      .then((s) => {
        setDisableRegistration(s.disableRegistration);
        setHasUploadApiToken(s.hasUploadApiToken);
        setTokenFromEnv(s.tokenFromEnv);
        setLlmSettings(s);
      })
      .catch(() => setError('Failed to load settings.'));
  }, []);

  async function onToggle(next: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const s = await updateSettings({ disableRegistration: next });
      setDisableRegistration(s.disableRegistration);
      setSaved(true);
    } catch {
      setError('Failed to save settings.');
    } finally {
      setBusy(false);
    }
  }

  async function onGenerateToken() {
    setTokenBusy(true);
    setTokenError(null);
    setTokenInput('');
    try {
      const res = await generateUploadToken();
      setTokenInput(res.uploadApiToken);
      setHasUploadApiToken(true);
    } catch {
      setTokenError('Failed to generate token.');
    } finally {
      setTokenBusy(false);
    }
  }

  async function onClearToken() {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const s = await updateSettings({ uploadApiToken: null });
      setHasUploadApiToken(s.hasUploadApiToken);
      setTokenInput('');
    } catch {
      setTokenError('Failed to clear token.');
    } finally {
      setTokenBusy(false);
    }
  }

  function onCopyToken() {
    navigator.clipboard.writeText(tokenInput)
      .then(() => {
        setTokenCopied(true);
        setTimeout(() => setTokenCopied(false), 2000);
      })
      .catch(() => setTokenError('Could not copy to clipboard. Please copy manually.'));
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <Title>Settings</Title>
        <Text className="mt-1 dark:text-[var(--text-secondary)]">Global site configuration.</Text>
      </div>
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <Text className="font-medium">Disable registration</Text>
            <Text className="mt-1 text-sm text-gray-500 dark:text-[var(--text-muted)]">
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
          <Text className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</Text>
        ) : null}
        {saved ? (
          <Text className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">Saved.</Text>
        ) : null}
      </Card>

      <Card>
        <div className="space-y-4">
          <div>
            <Text className="font-medium">Upload API Token</Text>
            <Text className="mt-1 text-sm text-gray-500 dark:text-[var(--text-muted)]">
              A bearer token required for telemetry uploads. When set, the Torque
              app must include this token to authenticate uploads. This prevents
              unauthorized data ingestion using only a known email address.
              Generate a token and paste it into your Torque app&rsquo;s
              configuration. The token is shown only once.
            </Text>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                hasUploadApiToken
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-900/40 dark:text-emerald-300 dark:ring-emerald-600/40'
                  : 'bg-gray-50 text-gray-600 ring-1 ring-gray-500/10 dark:bg-[var(--bg-surface)] dark:text-[var(--text-secondary)] dark:ring-[var(--border-strong)]'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  hasUploadApiToken ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-gray-400 dark:bg-gray-500'
                }`}
              />
              {hasUploadApiToken ? 'Token set' : 'No token'}
            </span>
          </div>

          {tokenFromEnv ? (
            <Text className="text-sm text-amber-600 dark:text-amber-400">
              Token is managed via the <code className="font-mono bg-amber-50 px-1 rounded dark:bg-amber-900/40 dark:text-amber-300">UPLOAD_API_TOKEN</code> environment
              variable. Unset it to manage the token through the app UI.
            </Text>
          ) : null}

          {tokenInput ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded border bg-gray-50 px-3 py-2 text-sm font-mono dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]">
                  {tokenInput}
                </code>
                <button
                  type="button"
                  onClick={onCopyToken}
                  className="rounded border bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 transition-colors dark:border-[var(--border-default)] dark:bg-[var(--bg-card)] dark:text-[var(--text-primary)] dark:hover:bg-[var(--bg-surface)]"
                >
                  {tokenCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <Text className="text-xs text-amber-600 dark:text-amber-400">
                Copy this token now. It won&rsquo;t be shown again.
              </Text>
            </div>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onGenerateToken}
              disabled={tokenBusy || tokenFromEnv}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors dark:bg-indigo-500 dark:hover:bg-indigo-600"
            >
              {tokenBusy ? 'Generating...' : 'Generate New Token'}
            </button>
            {hasUploadApiToken && !tokenFromEnv ? (
              <button
                type="button"
                onClick={onClearToken}
                disabled={tokenBusy}
                className="rounded border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors dark:border-red-800 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-900/30"
              >
                Clear Token
              </button>
            ) : null}
          </div>

          {tokenError ? (
            <Text className="text-sm text-rose-600 dark:text-rose-400">{tokenError}</Text>
          ) : null}
        </div>
      </Card>

      <AiProviderCard settings={llmSettings} onUpdate={setLlmSettings} />
      <VehicleCard settings={llmSettings} onUpdate={setLlmSettings} />
    </div>
  );
}
