import { Children, type ReactNode, useState } from 'react'
import { classes } from '../text/classes'

const FIGURE = 'truncate font-medium text-2xl tabular-nums tracking-tight @lg/stats:text-3xl'

type Breakdown = readonly { label: string; value: string }[]

/**
 * Figures that must not be added together, one at a time at headline size,
 * with a dot per figure to switch between them.
 */
function BreakdownFigure({ items }: { items: Breakdown }) {
  const [index, setIndex] = useState(0)
  const current = items[Math.min(index, items.length - 1)]
  if (!current) return <div className={FIGURE}>-</div>
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={FIGURE} title={current.value}>
          {current.value}
        </span>
        <span className="truncate text-sm text-text-secondary">{current.label}</span>
      </div>
      {items.length > 1 ? (
        <fieldset className="m-0 flex items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">Choose a figure</legend>
          {items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              aria-label={`${item.label}: ${item.value}`}
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className="size-2 rounded-full bg-border-strong hover:bg-text-muted aria-pressed:bg-accent-fill"
            />
          ))}
        </fieldset>
      ) : null}
    </>
  )
}

/**
 * One headline figure: what it measures, the figure, and what bounds it. A
 * `breakdown` shows figures that are separate currencies one at a time.
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
        <BreakdownFigure items={breakdown} />
      ) : (
        <div
          data-tone={live ? 'success' : undefined}
          title={typeof figure === 'string' ? figure : undefined}
          className={classes(FIGURE, live && 'text-status-text')}
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
