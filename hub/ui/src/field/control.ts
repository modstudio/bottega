/**
 * The one look every text-entry control shares: border, surface, focus and
 * invalid states. Input, Textarea, the listbox trigger and SearchField use it.
 */
export const controlClasses =
  'min-w-0 border border-border-default bg-surface-page text-base text-text-primary transition-colors duration-(--duration-fast) placeholder:text-text-muted hover:border-border-strong focus-visible:border-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-control-disabled disabled:text-text-disabled aria-invalid:border-(--status-error) [&::-webkit-search-cancel-button]:hidden'
