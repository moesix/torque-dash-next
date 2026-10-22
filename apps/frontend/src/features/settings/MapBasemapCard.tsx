import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { updateSettings } from '@/lib/api';
import type { Settings } from '@/lib/types';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';

interface Props {
  settings: Settings;
  onUpdate: (settings: Settings) => void;
}

/**
 * "Map basemaps" admin card (spec'd design: keyless standard OSM is the
 * guaranteed base; CARTO is the opt-in admin upgrade requiring the admin's
 * API key). Structure mirrors AiProviderCard: server truth arrives as the
 * `settings` prop from SettingsPage's full-settings load; Badge reflects
 * the STORED state (not the unsaved draft); saving PUTs through lib/api's
 * updateSettings and reports back via onUpdate so the parent stays in sync.
 *
 * The saved cartoApiKey is a browser-map credential: it is held only in the
 * input's state (masked <input type="password">) and PUT request body —
 * never logged, never consoled.
 */
export default function MapBasemapCard({ settings, onUpdate }: Props) {
  const queryClient = useQueryClient();
  // Drafts sync from the loaded full settings; every server update
  // (including this card's own save response via onUpdate) re-runs the
  // effect so drafts always restart from the stored truth.
  const [providerDraft, setProviderDraft] = useState<'osm' | 'carto'>('osm');
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProviderDraft(settings.tileProvider === 'carto' ? 'carto' : 'osm');
    setKeyDraft(settings.cartoApiKey ?? '');
  }, [settings]);

  // Server-state truth for the status badge: CARTO configured with a
  // non-empty stored key actually serves CARTO tiles; CARTO configured with
  // a blank key degrades to OSM until a key is saved (same rule as
  // resolveTileTargets in GpsTrackMap).
  const storedProvider = settings.tileProvider === 'carto' ? 'carto' : 'osm';
  const storedKeyed = Boolean((settings.cartoApiKey ?? '').trim());
  const badgeCopy =
    storedProvider === 'carto'
      ? storedKeyed
        ? 'CARTO basemap'
        : 'CARTO selected — tiles fall back to standard OSM'
      : 'Standard OSM (default)';

  async function handleSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // The key is only sent while CARTO is being saved: a switch back to
      // OSM must not overwrite the stored key. Never logged.
      if (providerDraft === 'carto') {
        const s = await updateSettings({
          tileProvider: 'carto',
          cartoApiKey: keyDraft,
        });
        if (s) onUpdate(s);
      } else {
        const s = await updateSettings({ tileProvider: 'osm' });
        if (s) onUpdate(s);
      }
      setSaved(true);
      // Make the admin's own change map-visible immediately: the tile hook
      // holds a 5-min staleTime, so without this invalidation an already-open
      // SPA session keeps the old provider/key for up to 5 minutes.
      void queryClient.invalidateQueries({ queryKey: ['settings', 'tile'] });
    } catch {
      setError('Failed to save map basemap settings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="space-y-4">
        <div>
          <p className="text-sm leading-relaxed font-medium">Map basemaps</p>
          <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-[var(--text-muted)]">
            The default is standard OpenStreetMap and it needs no key. CARTO
            basemaps are an optional upgrade for your CARTO API key. The key
            ships to the browser in tile URLs, so allowlist your
            app&rsquo;s domain for it in the CARTO dashboard. Note: while OSM
            is active the stored key is hidden — switching back to CARTO
            requires re-entering it.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            tone={storedProvider === 'carto' ? (storedKeyed ? 'ok' : 'warn') : 'neutral'}
            dot
            title="Currently serving basemap"
          >
            {badgeCopy}
          </Badge>
        </div>

        <div>
          <label
            htmlFor="tile-provider"
            className="text-sm leading-relaxed font-medium text-gray-700 dark:text-[var(--text-secondary)]"
          >
            Provider
          </label>
          <select
            id="tile-provider"
            value={providerDraft}
            onChange={(e) => {
              setProviderDraft(e.target.value === 'carto' ? 'carto' : 'osm');
              setSaved(false);
            }}
            disabled={busy}
            className="mt-1 w-full rounded border bg-white px-3 py-2 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
          >
            <option value="osm">Standard OpenStreetMap (default)</option>
            <option value="carto">CARTO</option>
          </select>
        </div>

        {providerDraft === 'carto' ? (
          <div>
            <label
              htmlFor="carto-api-key"
              className="text-sm leading-relaxed font-medium text-gray-700 dark:text-[var(--text-secondary)]"
            >
              CARTO API key
            </label>
            <input
              id="carto-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={255}
              value={keyDraft}
              onChange={(e) => {
                setKeyDraft(e.target.value);
                setSaved(false);
              }}
              disabled={busy}
              placeholder="Your CARTO Basemaps API key"
              className="mt-1 w-full rounded border bg-white px-3 py-2 text-sm font-mono dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
            />
            {keyDraft.trim() === '' ? (
              <p className="mt-1 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                No key set — replay maps will fall back to standard
                OpenStreetMap until a key is saved.
              </p>
            ) : null}
            <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-[var(--text-muted)]">
              Verify the key after saving: a wrong key still serves vendor
              error-card tiles, so only exercising the map confirms it.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={handleSave} disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </div>

        {error ? (
          <p className="text-sm leading-relaxed text-rose-600 dark:text-rose-400">{error}</p>
        ) : null}
        {saved && !error ? (
          <p className="text-sm leading-relaxed text-emerald-600 dark:text-emerald-400">Saved.</p>
        ) : null}
      </div>
    </div>
  );
}
