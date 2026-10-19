import { X } from 'lucide-react'
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { IconButton } from '../button/button'
import { dialogDismiss } from '../dom/dialog-dismiss.ts'
import { bottomSheetStyles } from './bottom-sheet.styles.ts'

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
  const release = (event: PointerEvent<HTMLButtonElement>) => {
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
      {...dialogDismiss(onClose)}
      style={{ height: `${height}dvh` }}
      className={bottomSheetStyles({ dragging }).root()}
    >
      <div className={bottomSheetStyles().frame()}>
        <button
          type="button"
          aria-label="Resize sheet"
          className={bottomSheetStyles().resizeHandle()}
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
          <span aria-hidden className={bottomSheetStyles().resizeGrip()} />
        </button>
        <header className={bottomSheetStyles().header()}>
          <h2 className={bottomSheetStyles().title()}>{title}</h2>
          <IconButton size="sm" label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div data-density="touch" className={bottomSheetStyles().body()}>
          {children}
        </div>
      </div>
    </dialog>
  )
}
