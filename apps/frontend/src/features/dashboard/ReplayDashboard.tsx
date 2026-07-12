import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Card, Grid, Text, Title } from '@tremor/react';
import { getSession, getTelemetry } from '@/lib/api';
import { usePlaybackStore } from '@/app/playbackStore';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart';
import KpiCard from '@/components/charts/KpiCard';
import GaugeTile from '@/components/charts/GaugeTile';
import GpsTrackMap from '@/components/map/GpsTrackMap';
import PlaybackControls from './PlaybackControls';

export default function ReplayDashboard() {
  const { id } = useParams<{ id: string }>();
  const setCursorTime = usePlaybackStore((s) => s.setCursorTime);

  const sessionQuery = useQuery({
    queryKey: ['session', id],
    queryFn: () => getSession(id as string),
    enabled: !!id,
  });

  const from = sessionQuery.data?.startDate;
  const to = sessionQuery.data?.endDate;

  const telemetryQuery = useQuery({
    queryKey: ['telemetry', id, from, to],
    queryFn: () => getTelemetry(id as string, from as string, to as string, 10000),
    enabled: !!id && !!from && !!to,
  });

  const frames = telemetryQuery.data ?? [];

  // Reset the playback cursor whenever we switch sessions.
  useEffect(() => {
    setCursorTime(null);
  }, [id, setCursorTime]);

  if (sessionQuery.isLoading) {
    return (
      <Card>
        <Text>Loading session…</Text>
      </Card>
    );
  }
  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <Card>
        <Text className="text-rose-600">Session not found.</Text>
      </Card>
    );
  }

  const maxRpm = Math.max(0, ...frames.map((f) => f.engineRpm ?? 0));
  const maxSpeed = Math.max(0, ...frames.map((f) => f.vehicleSpeed ?? 0));

  return (
    <div className="space-y-4">
      <Card>
        <Title>{sessionQuery.data.name || 'Session Replay'}</Title>
        <Text>
          {sessionQuery.data.startDate
            ? new Date(sessionQuery.data.startDate).toLocaleString()
            : ''}
          {sessionQuery.data.duration ? ` · ${sessionQuery.data.duration}` : ''}
        </Text>
      </Card>

      <PlaybackControls frames={frames} />

      <Grid numItemsLg={4} className="gap-4">
        <KpiCard title="Max RPM" value={Math.round(maxRpm)} />
        <KpiCard title="Max Speed" value={`${Math.round(maxSpeed)} km/h`} />
        <GaugeTile title="Peak RPM" value={maxRpm} max={8000} unit=" rpm" />
        <GaugeTile title="Peak Speed" value={maxSpeed} max={240} unit=" km/h" />
      </Grid>

      <Grid numItemsLg={2} className="gap-4">
        <Card>
          <Title>Engine RPM</Title>
          <TimeSeriesChart
            frames={frames}
            metric="engineRpm"
            title="RPM"
            color="#2563eb"
          />
        </Card>
        <Card>
          <Title>Vehicle Speed</Title>
          <TimeSeriesChart
            frames={frames}
            metric="vehicleSpeed"
            title="km/h"
            color="#16a34a"
          />
        </Card>
      </Grid>

      <Card>
        <Title>GPS Track</Title>
        {telemetryQuery.isLoading ? (
          <Text className="mt-2">Loading telemetry…</Text>
        ) : (
          <div className="mt-2">
            <GpsTrackMap frames={frames} />
          </div>
        )}
      </Card>
    </div>
  );
}
