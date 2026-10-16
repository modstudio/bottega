import { classes } from '../text/classes'

/** A key or shortcut the reader presses. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      className={classes(
        'inline-flex h-5 min-w-5 items-center justify-center border border-border-default bg-surface-raised px-1 font-medium font-mono text-text-secondary text-xs',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
