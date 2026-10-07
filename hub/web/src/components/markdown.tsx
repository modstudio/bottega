import { Maximize2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { secondLevelHeadings } from '@/docs/headings'
import { Button } from '@/ui/button/button'
import { Dialog } from '@/ui/dialog/dialog'

/**
 * A table scrolls inside the reading measure. One too wide for it also offers to open at the
 * window's width, where its columns can be read side by side.
 */
function DocTable({ children }: { children: ReactNode }) {
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
    return () => observer.disconnect()
  }, [])
  return (
    <div className="doc-table">
      {wide ? (
        <div className="doc-table-actions">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Maximize2 size={13} />
            Expand table
          </Button>
        </div>
      ) : null}
      <div className="doc-table-scroll" ref={scroller}>
        <table>{children}</table>
      </div>
      {open ? (
        <Dialog
          open
          onOpenChange={setOpen}
          title="Table"
          className="w-[min(96rem,calc(100vw-3rem))] max-w-none"
        >
          <div className="markdown doc-table-full">
            <table>{children}</table>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

// Raw HTML in a doc is NOT rendered (react-markdown's default).
export function Markdown({ content }: { content: string }) {
  const headings = secondLevelHeadings(content)
  let heading = 0
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => {
            const id = headings[heading++]?.id
            return <h2 id={id}>{children}</h2>
          },
          table: ({ children }) => <DocTable>{children}</DocTable>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
