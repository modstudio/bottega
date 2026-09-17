import { X } from 'lucide-react'
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../button/button'
import { classes } from '../text/classes'

const sizes = {
  default: 'w-(--sheet-w)',
  wide: 'w-(--sheet-w-wide)',
  document: 'w-(--sheet-w-document)',
} as const

/**
 * A record's settings, edited and closed. It covers the page and makes it
 * inert, but draws no scrim, because the list beside it is what the record
 * means. A click outside closes it. The header matches the top bar's height so
 * their rules meet; the foot pins the commit; a destructive block comes last.
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  actions,
  tabs,
  context,
  footer,
  destructive,
  size = 'default',
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  /** Controls acting on the whole record, beside the title. */
  actions?: ReactNode
  /** The record's areas, when it has more than one. */
  tabs?: ReactNode
  /** Standing context under the tabs, true on every tab. */
  context?: ReactNode
  footer?: ReactNode
  destructive?: ReactNode
  size?: keyof typeof sizes
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useLayoutEffect(() => {
    const node = ref.current
    if (open && node && !node.open) {
      node.showModal()
      // The browser focuses the first control, which may be a destructive action.
      close.current?.focus()
    }
    if (!open && node?.open) node.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className={classes(
        sizes[size],
        'fixed inset-y-0 right-0 left-auto h-dvh max-h-none max-w-full border-border-default border-l bg-surface-page text-text-primary shadow-overlay transition-[translate,opacity] duration-(--duration-base) starting:translate-x-6 starting:opacity-0',
      )}
    >
      <div className="flex h-full flex-col">
        <header className="flex min-h-(--topbar-h) shrink-0 items-center gap-3 border-border-default border-b px-5 py-2">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate font-semibold text-xl">
              {title}
            </h2>
            {subtitle ? <div className="text-sm text-text-secondary">{subtitle}</div> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          <IconButton ref={close} label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {tabs ? (
          <div className="shrink-0 border-border-subtle border-b px-5 py-2">{tabs}</div>
        ) : null}
        {context ? (
          <div className="shrink-0 px-5 pt-3 text-sm text-text-secondary">{context}</div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
          {destructive ? (
            <div data-tone="error" className="mt-8 border border-status-border p-4">
              {destructive}
            </div>
          ) : null}
        </div>
        {footer ? (
          <footer className="flex shrink-0 justify-end gap-2 border-border-default border-t px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  )
}
