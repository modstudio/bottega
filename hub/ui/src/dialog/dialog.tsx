import { X } from 'lucide-react'
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../button/button'
import { dialogStyles } from './dialog.styles.ts'

const sizes = {
  sm: 'w-[min(24rem,calc(100vw-2rem))]',
  md: 'w-[min(32rem,calc(100vw-2rem))]',
  lg: 'w-[min(40rem,calc(100vw-2rem))]',
  full: 'h-dvh w-screen max-w-none',
} as const

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
  size?: keyof typeof sizes
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
      onClose={() => onOpenChange(false)}
      onPointerDown={(event) => {
        // The backdrop belongs to the dialog element; its content fills the box.
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
      className={dialogStyles({ size, chromeless }).root({ class: className })}
    >
      <div className={dialogStyles().slot1()}>
        {chromeless ? (
          children
        ) : (
          <>
            <header className={dialogStyles().slot2()}>
              <div className={dialogStyles().slot3()}>
                <h2 id={titleId} className={dialogStyles().slot4()}>
                  {title}
                </h2>
                {description ? (
                  <div id={descriptionId} className={dialogStyles().slot5()}>
                    {description}
                  </div>
                ) : null}
              </div>
              <IconButton size="sm" label="Close" onClick={() => onOpenChange(false)}>
                <X />
              </IconButton>
            </header>
            {children ? <div className={dialogStyles().slot6()}>{children}</div> : null}
            {footer ? <footer className={dialogStyles().slot7()}>{footer}</footer> : null}
          </>
        )}
      </div>
    </dialog>
  )
}
