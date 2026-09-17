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
    <div className="flex min-w-0 flex-col gap-1 bg-surface-page p-5">
      <div className="text-sm text-text-secondary">{label}</div>
      <div
        data-tone={live ? 'success' : undefined}
        className={classes(
          'truncate font-medium text-3xl tabular-nums tracking-tight',
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
          'grid gap-px border border-border-default bg-border-default',
          '@lg/stats:grid-cols-2',
          count >= 3 && '@3xl/stats:grid-cols-3',
          count >= 4 && '@5xl/stats:grid-cols-4',
        )}
      >
        {children}
      </div>
    </div>
  )
}
