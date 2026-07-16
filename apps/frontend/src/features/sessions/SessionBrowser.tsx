import { useQuery } from '@tanstack/react-query';
import { Card, Text, Title } from '@tremor/react';
import { getSessions } from '@/lib/api';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import SessionTable from '@/components/tables/SessionTable';

export default function SessionBrowser() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sessions'],
    queryFn: getSessions,
  });

  if (isLoading) {
    return (
      <Card>
        <Title>Your Sessions</Title>
        <Text>Select a session to replay its telemetry.</Text>
        <div className="mt-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16 ml-auto" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <Title>Your Sessions</Title>
        <Text>Select a session to replay its telemetry.</Text>
        <div className="mt-4">
          <ErrorAlert
            message="Failed to load sessions. You may need to sign in again."
            onRetry={() => window.location.reload()}
          />
        </div>
      </Card>
    );
  }

  return (
    <Card className="session-card">
      <Title>Your Sessions</Title>
      <Text>Select a session to replay its telemetry.</Text>
      {data && data.length > 0 ? (
        <div className="mt-4">
          <SessionTable sessions={data} />
        </div>
      ) : null}
      {data && data.length === 0 ? (
        <Text className="mt-4">No sessions yet.</Text>
      ) : null}
    </Card>
  );
}
