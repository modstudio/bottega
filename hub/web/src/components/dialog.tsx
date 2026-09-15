import { X } from 'lucide-react'
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react'
import { cx } from '@/components/cx'

type DialogState = { open: boolean; onOpenChange: (open: boolean) => void }

const DialogContext = createContext<DialogState | null>(null)

function useDialog() {
  const value = useContext(DialogContext)
  if (!value) throw new Error('Dialog parts must be used inside Dialog')
  return value
}

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>
}

export function DialogContent({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDialogElement>) {
  const { open, onOpenChange } = useDialog()
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    if (open) {
      if (!node.open) node.showModal()
    } else if (node.open) {
      node.close()
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={() => onOpenChange(false)}
      className={cx(
        'fixed left-[50%] top-[50%] z-50 m-0 w-full max-w-lg translate-x-[-50%] translate-y-[-50%] border bg-background p-6 shadow-lg sm:rounded-none [&::backdrop]:bg-foreground/80',
        className,
      )}
      {...props}
    >
      <div className="grid gap-4">{children}</div>
      <button
        type="button"
        className="absolute right-4 top-4 rounded-none opacity-70 ring-offset-background hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
        onClick={() => onOpenChange(false)}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </button>
    </dialog>
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('flex flex-col space-y-1.5 text-center sm:text-left', className)}
      {...props}
    />
  )
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  )
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cx('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  )
}

export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx('text-sm text-muted-foreground', className)} {...props} />
}
