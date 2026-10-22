import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'icon';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = accent fill with dark ink (AA on teal); ghost = bordered
   *  surface that elevates on hover; icon = borderless square for icon/text
   *  glyph buttons in chrome rows. */
  variant?: ButtonVariant;
  size?: ButtonSize;
}

// Shared contract: consistent radius (rounded-lg), min 44px touch target,
// press feedback (active:translate-y-px under a transition that also covers
// the color change), and the global :focus-visible 2px accent outline from
// index.css (no per-component ring needed — it must stay uniform).
const BASE =
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium ' +
  'transition duration-150 active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0';

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-[44px] px-4 py-2.5 text-sm',
  sm: 'min-h-[44px] px-3 py-2 text-xs md:text-sm',
};

// Icon squares stay 44×44 so chart/tool glyphs are properly touchable.
const ICON_SIZE = 'min-h-[44px] min-w-[44px] p-2.5';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink shadow-xs hover:bg-accent-hover',
  ghost:
    'border border-border bg-surface-card text-fg-secondary shadow-xs ' +
    'hover:bg-surface-elevated hover:text-fg',
  icon: 'text-fg-muted hover:bg-surface-elevated hover:text-fg',
};

/**
 * The app's button primitive. Use it instead of hand-rolled accent fills so
 * touch-target size, press feedback, and the focus ring stay identical
 * everywhere.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  ...rest
}: ButtonProps) {
  const sizeClass = variant === 'icon' ? ICON_SIZE : SIZES[size];
  return (
    <button
      type={type}
      className={`${VARIANTS[variant]} ${sizeClass} ${className}`}
      {...rest}
    />
  );
}
