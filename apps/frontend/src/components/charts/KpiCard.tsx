interface Props {
  title: string;
  value: string | number;
  hint?: string;
}

export default function KpiCard({ title, value, hint }: Props) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
      <p className="text-sm leading-relaxed">{title}</p>
      <p className="text-3xl font-bold leading-tight tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}
