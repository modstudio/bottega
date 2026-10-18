import { X } from 'lucide-react'
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../button/button'
import { dialogStyles } from './dialog.styles.ts'

/**
 * A decision the reader answers and dismisses. A modal `<dialog>`: the browser
 * traps focus, makes the page inert and closes on Escape; we add the scrim and
 * close on a click outside the box. Chromeless drops the title bar and close
 * icon; `title` remains the accessible name.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = 'md',
  variant = 'default',
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  /** Actions, right-aligned; the primary action last. */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'full'
  variant?: 'default' | 'chromeless'
  /** Layout only: margin, size and placement. */
  className?: string
  children?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const chromeless = variant === 'chromeless'

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={chromeless ? title : undefined}
      aria-labelledby={chromeless ? undefined : titleId}
      aria-describedby={!chromeless && description ? descriptionId : undefined}
      onClose={(event) => {
        // React passes a nested dialog's close up the tree; only this dialog's own close counts.
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
      onPointerDown={(event) => {
        // The backdrop belongs to the dialog element; its content fills the box.
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
      className={dialogStyles({ size, chromeless }).root({ class: className })}
    >
      <div className={dialogStyles().frame()}>
        {chromeless ? (
          children
        ) : (
          <>
            <header className={dialogStyles().header()}>
              <div className={dialogStyles().heading()}>
                <h2 id={titleId} className={dialogStyles().title()}>
                  {title}
                </h2>
                {description ? (
                  <div id={descriptionId} className={dialogStyles().description()}>
                    {description}
                  </div>
                ) : null}
              </div>
              <IconButton size="sm" label="Close" onClick={() => onOpenChange(false)}>
                <X />
              </IconButton>
            </header>
            {children ? <div className={dialogStyles().body()}>{children}</div> : null}
            {footer ? <footer className={dialogStyles().footer()}>{footer}</footer> : null}
          </>
        )}
      </div>
    </dialog>
  )
}
