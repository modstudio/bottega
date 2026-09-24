/**
 * The product mark: a workshop's arched doorway. Drawn in the current color,
 * so it follows the theme; `public/favicon.svg` is the same drawing on a tile.
 */
export function AppMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 21V10a8 8 0 0 1 16 0v11" />
      <path d="M9 21v-6a3 3 0 0 1 6 0v6" />
      <path d="M2 21h20" />
    </svg>
  )
}
