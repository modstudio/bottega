import { Children, type ReactNode, useState } from 'react'
import { statStyles } from './stat.styles.ts'

type Breakdown = readonly { label: string; value: string }[]

/**
 * Figures that must not be added together, one at a time at headline size,
 * with a dot per figure to switch between them.
 */
function BreakdownFigure({ items }: { items: Breakdown }) {
  const [index, setIndex] = useState(0)
  const current = items[Math.min(index, items.length - 1)]
  if (!current) return <div className={statStyles().figure()}>-</div>
  return (
    <>
      <div className={statStyles().figureHeading()}>
        <span className={statStyles().figure()} title={current.value}>
          {current.value}
        </span>
        <span className={statStyles().figureLabel()}>{current.label}</span>
      </div>
      {items.length > 1 ? (
        <fieldset className={statStyles().figurePicker()}>
          <legend className={statStyles().figurePickerLegend()}>Choose a figure</legend>
          {items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              aria-label={`${item.label}: ${item.value}`}
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className={statStyles().figurePickerOption()}
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
  wrapHint = false,
}: {
  figure?: ReactNode
  breakdown?: Breakdown
  label: ReactNode
  hint?: ReactNode
  /** The figure is still moving, as while agents are working. */
  live?: boolean
  /** Honesty text that must remain visible rather than collapsing to one line. */
  wrapHint?: boolean
}) {
  return (
    <div className={statStyles().card()}>
      <div className={statStyles().cardLabel()}>{label}</div>
      {breakdown ? (
        <BreakdownFigure items={breakdown} />
      ) : (
        <div
          data-tone={live ? 'success' : undefined}
          title={typeof figure === 'string' ? figure : undefined}
          className={statStyles({ live }).figure()}
        >
          {figure}
        </div>
      )}
      {hint ? <div className={statStyles({ wrapHint }).hint()}>{hint}</div> : null}
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
    <div className={statStyles().group()}>
      <div className={statStyles({ three: count >= 3, four: count >= 4 }).row()}>{children}</div>
    </div>
  )
}
