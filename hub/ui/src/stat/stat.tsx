import { ChevronDown, ChevronUp } from 'lucide-react'
import { Children, createContext, type ReactNode, useContext, useState } from 'react'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
import { statStyles } from './stat.styles.ts'

type Breakdown = readonly { label: string; value: string }[]

/** On a phone the row reads as one line of figures until it is opened. */
const Compact = createContext(false)

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
  if (useContext(Compact)) {
    return (
      <div className={statStyles().chip()}>
        <span
          data-tone={live ? 'success' : undefined}
          className={statStyles({ live }).chipFigure()}
        >
          {breakdown ? (breakdown[0]?.value ?? '-') : figure}
        </span>
        <span className={statStyles().chipLabel()}>{label}</span>
      </div>
    )
  }
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
 * own width rather than the window's. On a phone they read as one line that
 * scrolls sideways, and open into the full tiles, one per row.
 */
export function StatRow({ children }: { children: ReactNode }) {
  const count = Children.toArray(children).length
  const phone = useMediaQuery(PHONE_QUERY)
  const [open, setOpen] = useState(false)
  if (phone && !open) {
    return (
      <div className={statStyles().band()}>
        <Compact.Provider value>
          <div className={statStyles().bandFigures()}>{children}</div>
        </Compact.Provider>
        <button
          type="button"
          aria-expanded={false}
          aria-label="Show the figures in full"
          className={statStyles().bandToggle()}
          onClick={() => setOpen(true)}
        >
          <ChevronDown aria-hidden />
        </button>
      </div>
    )
  }
  return (
    <div className={statStyles().group()}>
      <div className={statStyles({ three: count >= 3, four: count >= 4, phone }).row()}>
        {children}
      </div>
      {phone ? (
        <button
          type="button"
          aria-expanded
          className={statStyles().less()}
          onClick={() => setOpen(false)}
        >
          <ChevronUp aria-hidden />
          Show less
        </button>
      ) : null}
    </div>
  )
}
