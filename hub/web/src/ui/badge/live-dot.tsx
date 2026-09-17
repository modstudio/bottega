/** A pulsing dot for work that is running right now. */
export function LiveDot() {
  return (
    <span
      data-tone="success"
      className="relative inline-block size-1.5 shrink-0 rounded-full bg-status-fill motion-safe:animate-pulse"
    >
      <span className="sr-only">Running</span>
    </span>
  )
}
