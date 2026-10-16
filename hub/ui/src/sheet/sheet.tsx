import { X } from 'lucide-react'
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../button/button'
import { sheetStyles } from './sheet.styles.ts'

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
      className={sheetStyles({ size }).root()}
    >
      <div className={sheetStyles().slot1()}>
        <header className={sheetStyles().slot2()}>
          <div className={sheetStyles().slot3()}>
            <h2 id={titleId} className={sheetStyles().slot4()}>
              {title}
            </h2>
            {subtitle ? <div className={sheetStyles().slot5()}>{subtitle}</div> : null}
          </div>
          {actions ? <div className={sheetStyles().slot6()}>{actions}</div> : null}
          <IconButton ref={close} label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {tabs ? <div className={sheetStyles().slot7()}>{tabs}</div> : null}
        {context ? <div className={sheetStyles().slot8()}>{context}</div> : null}
        <div className={sheetStyles().slot9()}>
          {children}
          {destructive ? (
            <div data-tone="error" className={sheetStyles().slot10()}>
              {destructive}
            </div>
          ) : null}
        </div>
        {footer ? <footer className={sheetStyles().slot11()}>{footer}</footer> : null}
      </div>
    </dialog>
  )
}
