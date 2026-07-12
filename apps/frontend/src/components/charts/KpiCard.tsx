import { Card, Metric, Text, Title } from '@tremor/react';

interface Props {
  title: string;
  value: string | number;
  hint?: string;
}

export default function KpiCard({ title, value, hint }: Props) {
  return (
    <Card>
      <Text>{title}</Text>
      <Metric>{value}</Metric>
      {hint ? <Text className="mt-1 text-xs">{hint}</Text> : null}
    </Card>
  );
}
