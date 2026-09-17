import { SlidersHorizontal } from 'lucide-react'
import { Children, type ReactNode } from 'react'
import { Button } from '../button/button'
import { useMediaQuery } from '../dom/use-media-query'
import { Popover } from '../popover/popover'
import { classes } from '../text/classes'
import { ToolbarBand } from '../toolbar-band/toolbar-band'

/** More filters than this always sit behind the Filters trigger, whatever the width. */
const FILTERS_INLINE_MAX = 2

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
 * first, then the filters fold behind one labelled trigger. The measure is the
 * card's own width, so a docked panel collapses the toolbar on any screen. On a
 * phone the toolbar is replaced by one band of cells, and `pageActions` (the
 * page header's own buttons) move into it.
 */
export function TableCard({
  heading,
  tabs,
  search,
  filters,
  filtersActive = 0,
  view,
  actions,
  meta,
  pageActions,
  footer,
  panel,
  children,
}: {
  /** The collection's name and count. */
  heading?: ReactNode
  /** Which collection is shown, such as a status strip. */
  tabs?: ReactNode
  search?: ReactNode
  /** Filter controls, one per child. */
  filters?: ReactNode
  /** How many filters are applied, shown on the collapsed trigger. */
  filtersActive?: number
  /** How the rows are drawn: window, density, layout. */
  view?: ReactNode
  /** One or two controls acting on the collection. */
  actions?: ReactNode
  /** Expendable context, such as a result count. Dropped first. */
  meta?: ReactNode
  /** The page header's buttons; on a phone they join the band. */
  pageActions?: ReactNode
  /** Pinned under the rows: pagination or batch actions. */
  footer?: ReactNode
  /** A companion docked beside the rows. */
  panel?: ReactNode
  children: ReactNode
}) {
  const phone = useMediaQuery('(max-width: 767px)')
  const filterCount = Children.toArray(filters).length
  const filterTrigger = filters ? (
    <Popover
      label="Filters"
      trigger={
        <Button size="sm">
          <SlidersHorizontal />
          Filters
          {filtersActive ? (
            <span className="grid size-4 place-items-center rounded-full bg-accent-fill text-[10px] text-accent-on-fill tabular-nums">
              {filtersActive > 9 ? '9+' : filtersActive}
            </span>
          ) : null}
        </Button>
      }
    >
      <div className="flex min-w-60 flex-col gap-2 [&_button[role=combobox]]:w-full">{filters}</div>
    </Popover>
  ) : null
  const inlineFilters = filterCount > 0 && filterCount <= FILTERS_INLINE_MAX

  return (
    <section className="@container/card flex min-w-0 flex-col gap-3">
      {phone ? (
        <>
          {heading ? <div className="flex items-baseline gap-2">{heading}</div> : null}
          <ToolbarBand
            search={search}
            filters={filters}
            filtersActive={filtersActive > 0}
            view={view}
            tabs={tabs}
            actions={
              pageActions || actions ? (
                <>
                  {pageActions}
                  {actions}
                </>
              ) : undefined
            }
          />
        </>
      ) : (
        <div className="flex min-h-9 min-w-0 flex-nowrap items-center gap-2">
          {heading ? (
            <div className="mr-2 flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              {heading}
            </div>
          ) : null}
          {tabs ? <div className="flex shrink-0 items-center">{tabs}</div> : null}
          {search ? <div className="min-w-40 shrink basis-60">{search}</div> : null}
          {inlineFilters ? (
            <>
              <div className="hidden shrink-0 items-center gap-2 @4xl/card:flex">{filters}</div>
              <div className="shrink-0 @4xl/card:hidden">{filterTrigger}</div>
            </>
          ) : (
            <div className="shrink-0">{filterTrigger}</div>
          )}
          {meta ? (
            <div className="hidden shrink-0 text-sm text-text-muted @3xl/card:block">{meta}</div>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {view}
            {actions}
          </div>
        </div>
      )}
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
