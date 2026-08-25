import { useQuery } from '@tanstack/react-query';
import { getSession, getTelemetry } from '@/lib/api';

export function useSessionTelemetry(id: string | undefined) {
    const sessionQuery = useQuery({
        queryKey: ['session', id],
        queryFn: () => getSession(id as string),
        enabled: !!id,
    });

    const from = sessionQuery.data?.startDate;
    const to = sessionQuery.data?.endDate;

    const telemetryQuery = useQuery({
        queryKey: ['telemetry', id, from, to],
        queryFn: () => getTelemetry(id as string, from as string, to as string),
        enabled: !!id && !!from && !!to,
    });

    return {
        session: sessionQuery.data,
        frames: telemetryQuery.data ?? [],
        isLoading: sessionQuery.isLoading || telemetryQuery.isLoading,
        error: sessionQuery.error || telemetryQuery.error,
    };
}