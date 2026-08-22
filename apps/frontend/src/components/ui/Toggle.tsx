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
 * works natively. The thumb is a CSS-transitioned span; the track uses the
 * project's teal accent in both light and dark mode.
 *
 * The `label` prop is rendered as a visually-hidden span inside the button so
 * the switch always has an accessible name without changing the visual design.
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
        focus:outline-none focus:ring-2 focus:ring-teal-400/20 focus:ring-offset-2 focus:ring-offset-white
        dark:focus:ring-teal-400/20
        dark:focus:ring-offset-[var(--bg-card)]
        ${checked ? 'bg-teal-600 dark:bg-teal-500' : 'bg-gray-200 dark:bg-gray-600'}
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
