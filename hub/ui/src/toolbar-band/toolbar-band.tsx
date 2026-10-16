import {
  type LucideIcon,
  Search,
  SlidersHorizontal,
  SquareMousePointer,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../bottom-sheet/bottom-sheet'
import { IconButton } from '../button/button'
import { toolbarBandStyles } from './toolbar-band.styles.ts'

type Section = { id: string; label: string; icon: LucideIcon; body: ReactNode; active?: boolean }

/**
 * The phone toolbar: one band of at most five equal cells, replacing the desk
 * toolbar rather than squeezing it. Each cell opens the same controls the desk
 * row shows, in a bottom sheet; search grows within the band, folding the other
 * cells away, so its field has the whole width.
 */
export function ToolbarBand({
  search,
  filters,
  filtersActive,
  view,
  tabs,
  actions,
}: {
  search?: ReactNode
  filters?: ReactNode
  filtersActive?: boolean
  view?: ReactNode
  tabs?: ReactNode
  actions?: ReactNode
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const searchRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (searching) searchRow.current?.querySelector('input')?.focus()
  }, [searching])

  const sections: Section[] = [
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
      <BottomSheet
        open={Boolean(current)}
        title={current?.label ?? ''}
        onClose={() => setOpen(null)}
      >
        {current?.body}
      </BottomSheet>
    </>
  )
}
