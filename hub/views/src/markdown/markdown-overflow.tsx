import { Button } from '@bottega/hub-ui/button'
import { Dialog } from '@bottega/hub-ui/dialog'
import { Maximize2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { markdownOverflowStyles } from './markdown-overflow.styles.ts'

/**
 * Content that scrolls inside the reading measure. When it is wider than the
 * measure, the same expand control the table uses opens it at the window's width.
 */
export function DocOverflow({
  expandLabel,
  title,
  children,
}: {
  expandLabel: string
  title: string
  children: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const measure = () => setWide(node.scrollWidth > node.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    return () => observer.disconnect()
  }, [])
  return (
    <div className={markdownOverflowStyles().root()}>
      {wide ? (
        <div className={markdownOverflowStyles().actions()}>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Maximize2 size={13} />
            {expandLabel}
          </Button>
        </div>
      ) : null}
      <div className={markdownOverflowStyles().scroll()} ref={scroller}>
        {children}
      </div>
      {open ? (
        <Dialog
          open
          onOpenChange={setOpen}
          title={title}
          className={markdownOverflowStyles().dialog()}
        >
          <div className={markdownOverflowStyles().full()}>{children}</div>
        </Dialog>
      ) : null}
    </div>
  )
}
