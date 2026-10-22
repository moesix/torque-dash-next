interface ChevronIconProps {
  className?: string;
}

/**
 * Inline chevron for collapsible headers. Rotate/fold it via the caller's
 * `rotate-0 | rotate-180 transition-transform` classes — the transform lives
 * on a real SVG, so the transition actually animates (the old text-glyph swaps
 * kept a dead `transition-transform` class on swapped text).
 *
 * Sized to the default Tailwind text scale of the rows it sits in; decorative,
 * so it's aria-hidden (the surrounding control carries the semantics).
 */
export default function ChevronIcon({ className = 'h-4 w-4' }: ChevronIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8l4 4 4-4" />
    </svg>
  );
}
