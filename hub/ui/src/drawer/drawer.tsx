import { X } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../button/button'
import { dialogDismiss } from '../dom/dialog-dismiss.ts'
import { drawerStyles } from './drawer.styles.ts'

/**
 * A list that slides in from the left over the page on a phone, where it cannot sit beside what
 * it lists. A scrim dims the page; a tap on it, Escape, or choosing an entry closes it.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      {...dialogDismiss(onClose)}
      className={drawerStyles().root()}
    >
      <div className={drawerStyles().frame()}>
        <header className={drawerStyles().header()}>
          <h2 className={drawerStyles().title()}>{title}</h2>
          <IconButton size="sm" label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div className={drawerStyles().body()}>{children}</div>
      </div>
    </dialog>
  )
}
