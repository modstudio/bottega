import { X } from 'lucide-react'
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../button/button'
import { classes } from '../text/classes'

const sizes = {
  sm: 'w-[min(24rem,calc(100vw-2rem))]',
  md: 'w-[min(32rem,calc(100vw-2rem))]',
  lg: 'w-[min(40rem,calc(100vw-2rem))]',
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
      className={classes(
        sizes[size],
        chromeless ? 'fixed inset-x-0 mx-auto' : 'fixed inset-0 m-auto max-h-[calc(100dvh-2rem)]',
        'border border-border-default bg-surface-overlay text-text-primary shadow-overlay backdrop:bg-scrim',
        'transition-[opacity,scale] duration-(--duration-base) starting:scale-98 starting:opacity-0',
        className,
      )}
    >
      <div className="flex max-h-[inherit] flex-col">
        {chromeless ? (
          children
        ) : (
          <>
            <header className="flex items-start gap-3 px-5 pt-5 pb-3">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="font-semibold text-lg">
                  {title}
                </h2>
                {description ? (
                  <div id={descriptionId} className="mt-1 text-text-secondary">
                    {description}
                  </div>
                ) : null}
              </div>
              <IconButton size="sm" label="Close" onClick={() => onOpenChange(false)}>
                <X />
              </IconButton>
            </header>
            {children ? <div className="min-h-0 overflow-y-auto px-5 pb-4">{children}</div> : null}
            {footer ? (
              <footer className="flex justify-end gap-2 border-border-default border-t px-5 py-3">
                {footer}
              </footer>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  )
}
