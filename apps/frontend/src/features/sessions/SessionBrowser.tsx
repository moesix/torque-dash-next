import { useQuery } from '@tanstack/react-query';
import { Card, Text, Title } from '@tremor/react';
import { getSessions } from '@/lib/api';
import SessionTable from '@/components/tables/SessionTable';

export default function SessionBrowser() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sessions'],
    queryFn: getSessions,
  });

  return (
    <Card>
      <Title>Your Sessions</Title>
      <Text>Select a session to replay its telemetry.</Text>

      {isLoading ? <Text className="mt-4">Loading sessions…</Text> : null}
      {isError ? (
        <Text className="mt-4 text-rose-600">
          Failed to load sessions. You may need to sign in again.
        </Text>
      ) : null}
      {data && data.length > 0 ? (
        <div className="mt-4">
          <SessionTable sessions={data} />
        </div>
      ) : null}
      {data && data.length === 0 && !isLoading ? (
        <Text className="mt-4">No sessions yet.</Text>
      ) : null}
    </Card>
  );
}
