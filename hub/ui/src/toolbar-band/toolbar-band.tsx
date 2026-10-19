import {
  CalendarRange,
  type LucideIcon,
  Search,
  SlidersHorizontal,
  SquareMousePointer,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { BottomSheet } from '../bottom-sheet/bottom-sheet'
import { IconButton } from '../button/button'
import { Tabs } from '../tabs/tabs'
import { toolbarBandStyles } from './toolbar-band.styles.ts'

/** A cell that opens a panel of the page itself, such as the list a phone hides, not the sheet. */
export type BandPanel = { id: string; label: string; icon: LucideIcon; onOpen: () => void }

type Section = { id: string; label: string; icon: LucideIcon; body: ReactNode; active?: boolean }

/**
 * The phone toolbar: one band of at most five equal cells, replacing the desk
 * toolbar rather than squeezing it. Every cell opens the same bottom sheet at its
 * own tab, so each control is a tab and a tap away; search grows within the band,
 * folding the other cells away, so its field has the whole width.
 */
export function ToolbarBand({
  panels = [],
  scope,
  search,
  filters,
  filtersActive,
  view,
  tabs,
  actions,
}: {
  /** Cells that open the page's own panels, first in the band. */
  panels?: readonly BandPanel[]
  /** What the page is scoped by, such as its time window; the first tab of the sheet. */
  scope?: ReactNode
  search?: ReactNode
  filters?: ReactNode
  filtersActive?: boolean
  view?: ReactNode
  tabs?: ReactNode
  actions?: ReactNode
}) {
  const [open, setOpen] = useState<string | null>(null)
  const tabsId = useId()
  const [searching, setSearching] = useState(false)
  const searchRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (searching) searchRow.current?.querySelector('input')?.focus()
  }, [searching])

  const sections: Section[] = [
    ...(scope ? [{ id: 'scope', label: 'Scope', icon: CalendarRange, body: scope }] : []),
    ...(filters
      ? [
          {
            id: 'filters',
            label: 'Filters',
            icon: SlidersHorizontal,
            body: filters,
            active: filtersActive,
          },
        ]
      : []),
    ...(view ? [{ id: 'view', label: 'View', icon: SquareMousePointer, body: view }] : []),
    ...(tabs ? [{ id: 'show', label: 'Show', icon: SquareMousePointer, body: tabs }] : []),
    ...(actions ? [{ id: 'actions', label: 'Actions', icon: Zap, body: actions }] : []),
  ]
  const current = sections.find((section) => section.id === open)

  return (
    <>
      <div className={toolbarBandStyles().root()}>
        {panels.map((panel) => {
          const Icon = panel.icon
          return (
            <button
              key={panel.id}
              type="button"
              tabIndex={searching ? -1 : undefined}
              aria-hidden={searching || undefined}
              className={toolbarBandStyles({ searching }).cell()}
              onClick={panel.onOpen}
            >
              <Icon aria-hidden />
              {panel.label}
            </button>
          )
        })}
        {search ? (
          <div ref={searchRow} className={toolbarBandStyles({ search: true }).cell()}>
            {searching ? (
              <div className={toolbarBandStyles().search()}>
                {search}
                <IconButton size="sm" label="Close search" onClick={() => setSearching(false)}>
                  <X />
                </IconButton>
              </div>
            ) : (
              <button
                type="button"
                className={toolbarBandStyles().searchTrigger()}
                onClick={() => setSearching(true)}
              >
                <Search aria-hidden />
                Search
              </button>
            )}
          </div>
        ) : null}
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <button
              key={section.id}
              type="button"
              tabIndex={searching ? -1 : undefined}
              aria-hidden={searching || undefined}
              className={toolbarBandStyles({ searching }).cell()}
              onClick={() => setOpen(section.id)}
            >
              <Icon aria-hidden />
              {section.label}
              {section.active ? (
                <>
                  <span
                    aria-hidden
                    data-tone="info"
                    className={toolbarBandStyles().activeIndicator()}
                  />
                  <span className={toolbarBandStyles().activeLabel()}>(applied)</span>
                </>
              ) : null}
            </button>
          )
        })}
      </div>
      <BottomSheet open={Boolean(current)} title="Controls" onClose={() => setOpen(null)}>
        {sections.length > 1 ? (
          <div className={toolbarBandStyles().sheetTabs()}>
            <Tabs
              id={tabsId}
              label="Controls"
              value={current?.id ?? ''}
              onChange={setOpen}
              items={sections.map((section) => ({ value: section.id, label: section.label }))}
            />
          </div>
        ) : null}
        {sections.length > 1 ? (
          <div
            role="tabpanel"
            id={`${tabsId}-panel`}
            aria-labelledby={`${tabsId}-tab-${current?.id}`}
            className={toolbarBandStyles().sheetBody()}
          >
            {current?.body}
          </div>
        ) : (
          <div className={toolbarBandStyles().sheetBody()}>{current?.body}</div>
        )}
      </BottomSheet>
    </>
  )
}
