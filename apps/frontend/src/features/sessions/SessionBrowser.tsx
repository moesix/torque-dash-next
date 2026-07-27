import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Text, Title } from '@tremor/react';
import { getSessions } from '@/lib/api';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import SessionTable from '@/components/tables/SessionTable';

export default function SessionBrowser() {
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['sessions', offset],
    queryFn: () => getSessions(limit, offset),
  });

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const hasMore = offset + limit < total;

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
      {sessions.length > 0 ? (
        <div className="mt-4">
          <SessionTable sessions={sessions} />
          {hasMore && (
            <button
              onClick={() => setOffset((prev) => prev + limit)}
              className="mt-4 rounded bg-gray-100 px-4 py-2 text-sm hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600"
            >
              Load More ({sessions.length} of {total})
            </button>
          )}
        </div>
      ) : null}
      {!isLoading && total === 0 ? (
        <Text className="mt-4">No sessions yet.</Text>
      ) : null}
    </Card>
  );
}
