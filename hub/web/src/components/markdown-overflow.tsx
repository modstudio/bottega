import { Maximize2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'

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
    <div className="doc-table">
      {wide ? (
        <div className="doc-table-actions">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Maximize2 size={13} />
            {expandLabel}
          </Button>
        </div>
      ) : null}
      <div className="doc-table-scroll" ref={scroller}>
        {children}
      </div>
      {open ? (
        <Dialog
          open
          onOpenChange={setOpen}
          title={title}
          className="w-[min(96rem,calc(100vw-3rem))] max-w-none"
        >
          <div className="markdown doc-table-full">{children}</div>
        </Dialog>
      ) : null}
    </div>
  )
}
