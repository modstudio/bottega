import { SlidersHorizontal } from 'lucide-react'
import { Children, type ReactNode } from 'react'
import { Button } from '../button/button'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
import { Popover } from '../popover/popover'
import { ToolbarBand } from '../toolbar-band/toolbar-band'
import { tableCardStyles } from './table-card.styles.ts'

/** More filters than this always sit behind the Filters trigger, whatever the width. */
/**
 * The card width from which filters sit inline instead of behind the Filters
 * trigger, by how many there are. Each filter needs about a select's width; past
 * the last band they always group. Classes are written out so Tailwind sees them.
 */
const FILTER_BANDS = [
  { max: 2, show: 'hidden @3xl/card:flex', hide: '@3xl/card:hidden' },
  { max: 4, show: 'hidden @5xl/card:flex', hide: '@5xl/card:hidden' },
  { max: 6, show: 'hidden @7xl/card:flex', hide: '@7xl/card:hidden' },
] as const

type ToolbarProps = {
  heading?: ReactNode
  tabs?: ReactNode
  search?: ReactNode
  filters?: ReactNode
  filtersActive: number
  view?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
  pageActions?: ReactNode
}

function FiltersTrigger({ filters, active }: { filters: ReactNode; active: number }) {
  return (
    <Popover
      label="Filters"
      trigger={
        <Button size="sm">
          <SlidersHorizontal />
          Filters
          {active ? (
            <span className={tableCardStyles().slot1()}>{active > 9 ? '9+' : active}</span>
          ) : null}
        </Button>
      }
    >
      <div className={tableCardStyles().slot2()}>{filters}</div>
    </Popover>
  )
}

/** The desk row: one line, giving up room by kind as the card narrows. */
function DeskToolbar({
  heading,
  tabs,
  search,
  filters,
  filtersActive,
  view,
  actions,
  meta,
}: ToolbarProps) {
  const filterCount = Children.toArray(filters).length
  const trigger = filters ? <FiltersTrigger filters={filters} active={filtersActive} /> : null
  const band = filterCount > 0 ? FILTER_BANDS.find((b) => filterCount <= b.max) : undefined
  return (
    <div className={tableCardStyles().slot3()}>
      {heading ? <div className={tableCardStyles().slot4()}>{heading}</div> : null}
      {tabs ? <div className={tableCardStyles().slot5()}>{tabs}</div> : null}
      {search ? <div className={tableCardStyles().slot6()}>{search}</div> : null}
      {band ? (
        <>
          <div className={tableCardStyles().filters({ class: band.show })}>{filters}</div>
          <div className={tableCardStyles().filterTrigger({ class: band.hide })}>{trigger}</div>
        </>
      ) : (
        <div className={tableCardStyles().slot7()}>{trigger}</div>
      )}
      {meta ? <div className={tableCardStyles().slot8()}>{meta}</div> : null}
      <div className={tableCardStyles().slot9()}>
        {view}
        {actions}
      </div>
    </div>
  )
}

/** The phone toolbar: the heading, then one band of cells; page actions join it. */
function PhoneToolbar({
  heading,
  tabs,
  search,
  filters,
  filtersActive,
  view,
  actions,
  pageActions,
}: ToolbarProps) {
  const combined =
    pageActions || actions ? (
      <>
        {pageActions}
        {actions}
      </>
    ) : undefined
  return (
    <>
      {heading ? <div className={tableCardStyles().slot10()}>{heading}</div> : null}
      <ToolbarBand
        search={search}
        filters={filters}
        filtersActive={filtersActive > 0}
        view={view}
        tabs={tabs}
        actions={combined}
      />
    </>
  )
}

/**
 * A collection and everything that acts on it. The toolbar sits on the page
 * above the card, with no box of its own; the card is the data. Every table
 * uses the same slots:
 *
 *   heading  tabs  search  filters…  meta      view  actions
 *   ┌──────────────────────────────────────────────┬─────────┐
 *   │ rows                                          │ panel   │
 *   ├──────────────────────────────────────────────┤         │
 *   │ footer                                        │         │
 *   └──────────────────────────────────────────────┴─────────┘
 *
 * As the card narrows it gives up room by kind, never by wrapping: meta goes
 * first, then the filters fold behind one labeled trigger. The measure is the
 * card's own width, so a docked panel collapses the toolbar on any screen. On a
 * phone the toolbar is replaced by one band of cells, and `pageActions` (the
 * page header's own buttons) move into it.
 */
export function TableCard({
  footer,
  panel,
  children,
  filtersActive = 0,
  ...toolbar
}: Omit<ToolbarProps, 'filtersActive'> & {
  /** How many filters are applied, shown on the collapsed trigger. */
  filtersActive?: number
  /** Pinned under the rows: pagination or batch actions. */
  footer?: ReactNode
  /** A companion docked beside the rows. */
  panel?: ReactNode
  children: ReactNode
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const Toolbar = phone ? PhoneToolbar : DeskToolbar
  return (
    <section className={tableCardStyles().slot11()}>
      <Toolbar {...toolbar} filtersActive={filtersActive} />
      <div className={tableCardStyles().slot12()}>
        <div className={tableCardStyles({ panel: Boolean(panel) }).card()}>
          {/* Positioned, so absolutely placed content (screen-reader labels) is clipped with the rows. */}
          <div className={tableCardStyles().slot13()}>{children}</div>
          {footer ? <div className={tableCardStyles().slot14()}>{footer}</div> : null}
        </div>
        {panel}
      </div>
    </section>
  )
}
