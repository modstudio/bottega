import {
  type LucideIcon,
  Search,
  SlidersHorizontal,
  SquareMousePointer,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { IconButton } from '../button/button'

type Section = { id: string; label: string; icon: LucideIcon; body: ReactNode; active?: boolean }

function BottomSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = ref.current
    if (open && node && !node.open) node.showModal()
    if (!open && node?.open) node.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-x-0 top-auto bottom-0 max-h-[80dvh] w-full max-w-none border-border-default border-t bg-surface-overlay text-text-primary shadow-overlay transition-[translate] duration-(--duration-base) backdrop:bg-scrim starting:translate-y-full"
    >
      <div className="flex max-h-[inherit] flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-border-subtle border-b px-4">
          <h2 className="font-semibold text-md">{title}</h2>
          <IconButton size="sm" label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4 [&_button[role=combobox]]:w-full">
          {children}
        </div>
      </div>
    </dialog>
  )
}

/**
 * The phone toolbar: one band of at most five equal cells, replacing the desk
 * toolbar rather than squeezing it. Each cell opens the same controls the desk
 * row shows, in a bottom sheet; search opens over the band so its field has the
 * whole width.
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

  if (searching && search) {
    return (
      <div ref={searchRow} className="flex items-center gap-2 [&>*:first-child]:flex-1">
        {search}
        <IconButton label="Close search" onClick={() => setSearching(false)}>
          <X />
        </IconButton>
      </div>
    )
  }

  const cell =
    'relative flex h-10 flex-1 basis-0 items-center justify-center gap-1.5 text-sm text-text-secondary hover:bg-control-hover hover:text-text-primary [&_svg]:size-4'
  return (
    <>
      <div className="flex divide-x divide-border-default border border-border-default bg-surface-page">
        {search ? (
          <button type="button" className={cell} onClick={() => setSearching(true)}>
            <Search aria-hidden />
            Search
          </button>
        ) : null}
        {sections.map((section) => {
          const Icon = section.icon
          return (
            <button
              key={section.id}
              type="button"
              className={cell}
              onClick={() => setOpen(section.id)}
            >
              <Icon aria-hidden />
              {section.label}
              {section.active ? (
                <>
                  <span
                    aria-hidden
                    data-tone="info"
                    className="absolute top-2 right-3 size-1.5 rounded-full bg-status-fill"
                  />
                  <span className="sr-only">(applied)</span>
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
