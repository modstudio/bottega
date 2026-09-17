import { Children, type ReactNode } from 'react'
import { classes } from '../text/classes'

/** One headline figure: what it measures, the figure, and what bounds it. */
export function StatTile({
  figure,
  label,
  hint,
  live = false,
}: {
  figure: ReactNode
  label: ReactNode
  hint?: ReactNode
  /** The figure is still moving, as while agents are working. */
  live?: boolean
}) {
  return (
    <div className="-mr-px -mb-px flex min-w-0 flex-col gap-1 border-border-default border-r border-b p-4 @lg/stats:p-5">
      <div className="text-sm text-text-secondary">{label}</div>
      <div
        data-tone={live ? 'success' : undefined}
        title={typeof figure === 'string' ? figure : undefined}
        className={classes(
          'truncate font-medium text-2xl tabular-nums tracking-tight @lg/stats:text-3xl',
          live && 'text-status-text',
        )}
      >
        {figure}
      </div>
      {hint ? <div className="truncate text-sm text-text-muted">{hint}</div> : null}
    </div>
  )
}

/**
 * Headline figures side by side, separated by hairlines, reflowing by the row's
 * own width rather than the window's.
 */
export function StatRow({ children }: { children: ReactNode }) {
  const count = Children.toArray(children).length
  return (
    <div className="@container/stats mb-6">
      <div
        className={classes(
          'grid grid-cols-2 overflow-hidden border border-border-default',
          count >= 3 && '@3xl/stats:grid-cols-3',
          count >= 4 && '@5xl/stats:grid-cols-4',
        )}
      >
        {children}
      </div>
    </div>
  )
}
