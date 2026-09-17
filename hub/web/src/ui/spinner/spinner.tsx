import { LoaderCircle } from 'lucide-react'
import { classes } from '../text/classes'

/** Work under way with no known end. `label` is announced; omit it when nearby text already says so. */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span role={label ? 'status' : undefined} className={classes('inline-flex', className)}>
      <LoaderCircle
        aria-hidden
        className="size-4 animate-spin text-text-muted motion-reduce:animate-none"
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}
