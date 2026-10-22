import type { CSSProperties, ReactNode } from 'react';

export type BadgeTone = 'ok' | 'warn' | 'info' | 'neutral' | 'danger';

/** Root color-mix base of each tone: semantic triplet + accent + muted ink. */
const TONE_COLOR: Record<BadgeTone, string> = {
  ok: 'var(--color-success)',
  warn: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  info: 'var(--accent)',
  neutral: 'var(--color-fg-muted)',
};

interface BadgeProps {
  tone?: BadgeTone;
  /** Small leading status dot in the full tone color (matches the old
   *  hand-rolled "Token set / Not configured" pills). */
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Status pill. One component replacing the ~5 hand-rolled
 * `bg-emerald-50 text-emerald-700 ring-1 ...` pill styles. Text and ring are
 * mixed from the tone's semantic color so the pill stays legible in both
 * themes and print (tokens are re-valued by the print rules, unlike literal
 * `dark:` classes).
 */
export default function Badge({
  tone = 'neutral',
  dot = false,
  title,
  className = '',
  children,
}: BadgeProps) {
  const color = TONE_COLOR[tone];
  const style: CSSProperties = {
    backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
    color: `color-mix(in srgb, ${color} 76%, var(--color-fg))`,
    // Tailwind v4 ring color custom property.
    ...({ '--tw-ring-color': `color-mix(in srgb, ${color} 32%, transparent)` } as CSSProperties),
  };

  return (
    <span
      title={title}
      style={style}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${className}`}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      {children}
    </span>
  );
}
