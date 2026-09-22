import { X } from 'lucide-react'
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { IconButton } from '../button/button'

/** Sheet heights as percentages of the viewport. */
const OPEN_HEIGHT = 75
const MIN_HEIGHT = 40
const CLOSE_BELOW = 25

/**
 * A phone sheet over the page's foot. It opens at a fixed height whatever it
 * holds; the handle drags it taller or shorter, and letting go low closes it.
 */
export function BottomSheet({
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
  const [height, setHeight] = useState(OPEN_HEIGHT)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (open) setHeight(OPEN_HEIGHT)
    if (open && node && !node.open) node.showModal()
    if (!open && node?.open) node.close()
  }, [open])

  const heightAt = (clientY: number) =>
    Math.min(100, Math.max(0, ((window.innerHeight - clientY) / window.innerHeight) * 100))
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    const released = heightAt(event.clientY)
    if (released < CLOSE_BELOW) onClose()
    else setHeight(Math.max(MIN_HEIGHT, released))
  }

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{ height: `${height}dvh` }}
      className={`fixed inset-x-0 top-auto bottom-0 max-h-none w-full max-w-none border-border-default border-t bg-surface-overlay text-text-primary shadow-overlay backdrop:bg-scrim starting:translate-y-full ${dragging ? '' : 'transition-[translate,height] duration-(--duration-base)'}`}
    >
      <div className="flex h-full flex-col">
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize sheet"
          className="flex h-5 shrink-0 cursor-row-resize touch-none items-center justify-center"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (dragging) setHeight(heightAt(event.clientY))
          }}
          onPointerUp={release}
          onPointerCancel={release}
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-border-strong" />
        </div>
        <header className="flex h-11 shrink-0 items-center justify-between border-border-subtle border-b px-4">
          <h2 className="font-semibold text-md">{title}</h2>
          <IconButton size="sm" label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 [&_button[role=combobox]]:w-full">
          {children}
        </div>
      </div>
    </dialog>
  )
}
