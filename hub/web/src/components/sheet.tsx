import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from './button'

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const panel = useRef<HTMLElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!open) return
    // This is deliberately not modal: the list stays visible and interactive so a
    // record can be read against its collection. Focus enters the panel and Escape
    // closes it, but Tab may leave it; a scrim would hide what the sheet exists to
    // inspect against.
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const escapeHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) close.current()
    }
    document.addEventListener('keydown', escapeHandler)
    return () => {
      document.removeEventListener('keydown', escapeHandler)
      opener.current?.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={typeof title === 'string' ? title : 'Record detail'}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(640px,100vw)] flex-col border-l border-border bg-[var(--surface-raised)] outline-none max-[900px]:w-screen"
    >
      <header className="flex min-h-14 items-start gap-3 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          <h1 className="font-sans text-[20px] font-semibold">{title}</h1>
          {subtitle ? <div className="mt-1 text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close panel">
          <X size={16} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      {footer ? (
        <footer className="border-t border-border bg-[var(--surface-raised)] p-4">{footer}</footer>
      ) : null}
    </aside>
  )
}
