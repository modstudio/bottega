import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { classes } from '@bottega/hub-ui/text/classes'

/**
 * The "In the code" section under an article: a disclosure whose heading keeps the reader's
 * heading style and counts the files. It starts collapsed because the paths serve the few
 * readers who look for them, unless there are none and the section is where they are added.
 */
export function CodeSection({
  count,
  defaultOpen = false,
  children,
}: {
  count: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="markdown mt-8">
      <h2>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span>In the code</span>
          <span className="font-mono text-sm text-text-muted tabular-nums">{count}</span>
          <ChevronDown
            size={16}
            aria-hidden
            className={classes(
              'ml-auto text-text-muted transition-transform duration-(--duration-fast)',
              open && 'rotate-180',
            )}
          />
        </button>
      </h2>
      {open ? children : null}
    </section>
  )
}
