import { SlidersHorizontal } from 'lucide-react'
import { Children, type ReactNode } from 'react'
import { Button } from '../button/button'
import { PHONE_QUERY, useMediaQuery } from '../dom/use-media-query'
import { Popover } from '../popover/popover'
import { classes } from '../text/classes'
import { ToolbarBand } from '../toolbar-band/toolbar-band'

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
            <span className="grid size-4 place-items-center rounded-full bg-accent-fill text-xs text-accent-on-fill tabular-nums">
              {active > 9 ? '9+' : active}
            </span>
          ) : null}
        </Button>
      }
    >
      <div className="flex min-w-60 flex-col gap-2 [&_button[role=combobox]]:w-full">{filters}</div>
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
    <div className="flex min-h-9 min-w-0 flex-nowrap items-center gap-2">
      {heading ? (
        <div className="mr-2 flex shrink-0 items-baseline gap-2 whitespace-nowrap">{heading}</div>
      ) : null}
      {tabs ? <div className="flex shrink-0 items-center">{tabs}</div> : null}
      {search ? <div className="min-w-40 shrink basis-60">{search}</div> : null}
      {band ? (
        <>
          <div className={classes('shrink-0 items-center gap-2', band.show)}>{filters}</div>
          <div className={classes('shrink-0', band.hide)}>{trigger}</div>
        </>
      ) : (
        <div className="shrink-0">{trigger}</div>
      )}
      {meta ? (
        <div className="hidden shrink-0 text-sm text-text-muted @3xl/card:block">{meta}</div>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
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
      {heading ? <div className="flex items-baseline gap-2">{heading}</div> : null}
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
    <section className="@container/card flex min-w-0 flex-col gap-3">
      <Toolbar {...toolbar} filtersActive={filtersActive} />
      <div className="flex min-h-0 min-w-0">
        <div
          className={classes(
            'flex min-w-0 flex-1 flex-col border border-border-default bg-surface-page',
            panel ? 'border-r-0' : null,
          )}
        >
          {/* Positioned, so absolutely placed content (screen-reader labels) is clipped with the rows. */}
          <div className="@container/rows relative min-w-0 overflow-auto">{children}</div>
          {footer ? <div className="border-border-default border-t px-3 py-2">{footer}</div> : null}
        </div>
        {panel}
      </div>
    </section>
  )
}
