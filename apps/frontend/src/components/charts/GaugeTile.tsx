import { Card, Text, Title } from '@tremor/react';

interface Props {
  title: string;
  value: number;
  max: number;
  unit?: string;
}

/**
 * Lightweight SVG ring gauge wrapped in a Tremor Card. Implemented with raw SVG
 * (instead of a charting lib) to keep the bundle small and avoid dependency on
 * a gauge component the design system may not ship.
 */
export default function GaugeTile({ title, value, max, unit = '' }: Props) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const pct = max > 0 ? Math.max(0, Math.min(1, safeValue / max)) : 0;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const dash = pct * circumference;
  const display = Math.round(safeValue);

  return (
    <Card>
      <Title>{title}</Title>
      <div className="flex items-center justify-center py-2">
        <svg
          width="140"
          height="140"
          viewBox="0 0 140 140"
          role="img"
          aria-label={`${title}: ${display}${unit}`}
        >
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            className="stroke-gray-200 dark:stroke-gray-700"
            strokeWidth="12"
          />
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            stroke="#2563eb"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            transform="rotate(-90 70 70)"
          />
          <text
            x="70"
            y="66"
            textAnchor="middle"
            fontSize="22"
            fontWeight="700"
            className="fill-gray-900 dark:fill-gray-100"
          >
            {display}
          </text>
          <text
            x="70"
            y="88"
            textAnchor="middle"
            fontSize="12"
            className="fill-gray-500 dark:fill-gray-400"
          >
            {unit.trim()}
          </text>
        </svg>
      </div>
      <Text className="text-center text-xs">of {Math.round(max)}{unit}</Text>
    </Card>
  );
}
