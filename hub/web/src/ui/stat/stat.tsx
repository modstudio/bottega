import { Children, type ReactNode } from 'react'
import { classes } from '../text/classes'

const BREAKDOWN_SHOWN = 3

type Breakdown = readonly { label: string; value: string }[]

/** Several figures that must not be added together, one per line; the rest behind a count. */
function BreakdownList({ items }: { items: Breakdown }) {
  const shown = items.slice(0, BREAKDOWN_SHOWN)
  const rest = items.slice(BREAKDOWN_SHOWN)
  return (
    <dl className="m-0 flex flex-col gap-0.5">
      {shown.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-3">
          <dt className="truncate text-text-secondary">{item.label}</dt>
          <dd className="m-0 font-medium text-lg tabular-nums">{item.value}</dd>
        </div>
      ))}
      {rest.length ? (
        <div
          className="text-sm text-text-muted"
          title={rest.map((item) => `${item.label} ${item.value}`).join(', ')}
        >
          +{rest.length} more
        </div>
      ) : null}
    </dl>
  )
}

/**
 * One headline figure: what it measures, the figure, and what bounds it. A
 * `breakdown` replaces the figure when the values are separate currencies.
 */
export function StatTile({
  figure,
  breakdown,
  label,
  hint,
  live = false,
}: {
  figure?: ReactNode
  breakdown?: Breakdown
  label: ReactNode
  hint?: ReactNode
  /** The figure is still moving, as while agents are working. */
  live?: boolean
}) {
  return (
    <div className="-mr-px -mb-px flex min-w-0 flex-col gap-1 border-border-default border-r border-b p-4 @lg/stats:p-5">
      <div className="text-sm text-text-secondary">{label}</div>
      {breakdown ? (
        <BreakdownList items={breakdown} />
      ) : (
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
      )}
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
