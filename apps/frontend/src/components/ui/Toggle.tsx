interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch (WCAG 4.1.2). Rendered visually hidden. */
  label: string;
}

/**
 * Accessible toggle switch (replaces Tremor `Switch`).
 *
 * Renders a `<button role="switch">` so keyboard activation (Enter/Space)
 * works natively. The thumb is a CSS-transitioned span; the checked track
 * uses the accent token family (`bg-accent`/`hover:bg-accent-hover`, which
 * follow the theme vars) instead of literal teal-palette classes. White
 * thumb vs #14b8a6 track is ≈2.2:1 — above the 2:1 switch-thumb threshold.
 *
 * The `label` prop is rendered as a visually-hidden span inside the button so
 * the switch always has an accessible name without changing the visual design.
 *
 * Focus: the global `:focus-visible` 2px accent outline from index.css is the
 * pattern — the previous ring-2 teal/20 was mouse-focus-only (not
 * focus-visible) and too faint against the white offset; removed so the
 * keyboard focus indicator matches every other control.
 */
export default function Toggle({ checked, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200
        ${checked ? 'bg-accent hover:bg-accent-hover' : 'bg-gray-200 dark:bg-gray-600'}
        ${disabled ? 'cursor-not-allowed opacity-50' : ''}
      `}
    >
      <span className="sr-only">{label}</span>
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200
          ${checked ? 'translate-x-6' : 'translate-x-1'}
        `}
        aria-hidden="true"
      />
    </button>
  );
}
