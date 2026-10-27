import { useCallback, useState } from 'react';
import { exportSessionCsv } from '@/lib/api';

/**
 * CSV download flow for the replay dashboard (moved verbatim out of
 * ReplayDashboard.tsx in plans/017 — behavior unchanged): owns the
 * `isExporting` spinner flag and the inline `exportError` message.
 */
export function useSessionExport(sessionId: string | undefined) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    if (!sessionId) return;
    setIsExporting(true);
    setExportError(null);
    try {
      await exportSessionCsv(sessionId);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setIsExporting(false);
    }
  }, [sessionId]);

  return { isExporting, exportError, handleExport };
}
