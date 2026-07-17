import { useState } from 'react';
import { Card, Text } from '@tremor/react';
import { updateLlmSettings, testLlmConnection } from '@/lib/api';
import type { Settings } from '@/lib/types';

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-nano'] },
  { value: 'anthropic', label: 'Anthropic', models: ['claude-sonnet-4-20250514', 'claude-3.5-haiku'] },
  { value: 'ollama', label: 'Ollama (Local)', models: ['llama3.1', 'mistral', 'codellama'] },
  { value: 'custom', label: 'Custom (OpenAI-compatible)', models: [] },
];

interface Props {
  settings: Settings;
  onUpdate: (settings: Settings) => void;
}

export default function AiProviderCard({ settings, onUpdate }: Props) {
  const [provider, setProvider] = useState(settings.llmProvider || '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.llmModel || '');
  const [endpoint, setEndpoint] = useState(settings.llmEndpoint || '');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = PROVIDERS.find(p => p.value === provider);
  const models = selectedProvider?.models || [];

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { llmProvider: provider || null };
      if (apiKey) body.llmApiKey = apiKey;
      if (model) body.llmModel = model;
      if (endpoint) body.llmEndpoint = endpoint;
      const updated = await updateLlmSettings(body);
      onUpdate(updated);
      setApiKey('');
      setTestResult(null);
    } catch {
      setError('Failed to save settings.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await testLlmConnection();
      if (res.ok) {
        setTestResult(`Connected! Response: "${res.response}"`);
      } else {
        setError(res.error || 'Test failed');
      }
    } catch {
      setError('Connection test failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <Text className="font-medium">AI Provider</Text>
          <Text className="mt-1 text-sm text-gray-500 dark:text-[var(--text-muted)]">
            Configure an LLM provider for session analysis. Your API key is
            encrypted at rest and never reaches the browser.
          </Text>
        </div>

        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            settings.hasLlmProvider
              ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-900/40 dark:text-emerald-300'
              : 'bg-gray-50 text-gray-600 ring-1 ring-gray-500/10 dark:bg-[var(--bg-surface)] dark:text-[var(--text-secondary)]'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${settings.hasLlmProvider ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            {settings.hasLlmProvider ? `Connected (${settings.llmProvider})` : 'Not configured'}
          </span>
        </div>

        <div>
          <Text className="text-sm font-medium mb-1">Provider</Text>
          <select
            value={provider}
            onChange={(e) => { setProvider(e.target.value); setModel(''); }}
            className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
          >
            <option value="">Select provider...</option>
            {PROVIDERS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <Text className="text-sm font-medium mb-1">API Key</Text>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.hasLlmApiKey ? '•••••••• (key set, leave blank to keep)' : 'Enter API key...'}
            className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
          />
        </div>

        {models.length > 0 && (
          <div>
            <Text className="text-sm font-medium mb-1">Model</Text>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            >
              <option value="">Default</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}

        {(provider === 'custom' || provider === 'ollama') && (
          <div>
            <Text className="text-sm font-medium mb-1">Model Name</Text>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. llama3.1, mistral, my-model"
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            />
          </div>
        )}

        {(provider === 'custom' || provider === 'ollama') && (
          <div>
            <Text className="text-sm font-medium mb-1">Endpoint URL</Text>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://your-api.com/v1'}
              className="w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)]"
            />
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !provider}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors dark:bg-indigo-500 dark:hover:bg-indigo-600"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
          {settings.hasLlmProvider && (
            <button
              type="button"
              onClick={handleTest}
              disabled={busy}
              className="rounded border bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors dark:border-[var(--border-default)] dark:bg-[var(--bg-card)] dark:hover:bg-[var(--bg-surface)]"
            >
              Test Connection
            </button>
          )}
        </div>

        {testResult && <Text className="text-sm text-emerald-600 dark:text-emerald-400">{testResult}</Text>}
        {error && <Text className="text-sm text-rose-600 dark:text-rose-400">{error}</Text>}
      </div>
    </Card>
  );
}
