import { useState, useCallback, useMemo, useEffect } from 'react';
import type { SeriesSource } from '@/lib/types';

const DEFAULT_PIDS = ['kc', 'vehicleSpeed', 'k5', 'ke', 'kff1214'];

export function usePidSelection(available: SeriesSource[], id: string | undefined) {
    const [selectedPids, setSelectedPids] = useState<string[]>(DEFAULT_PIDS);

    useEffect(() => {
        setSelectedPids(DEFAULT_PIDS);
    }, [id]);

    const selectedSources = useMemo(
        () => available.filter((s) => selectedPids.includes(s.pid)),
        [available, selectedPids],
    );

    const handleToggle = useCallback((pid: string) => {
        setSelectedPids((prev) =>
            prev.includes(pid) ? prev.filter((p) => p !== pid) : [...prev, pid],
        );
    }, []);

    const handleSelectAll = useCallback(() => {
        setSelectedPids(available.map((s) => s.pid));
    }, [available]);

    const handleClear = useCallback(() => {
        setSelectedPids([]);
    }, []);

    const handleReset = useCallback(() => {
        setSelectedPids(DEFAULT_PIDS);
    }, []);

    return { selectedPids, selectedSources, handleToggle, handleSelectAll, handleClear, handleReset };
}