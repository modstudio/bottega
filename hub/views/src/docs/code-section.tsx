import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { codeSectionStyles } from './code-section.styles.ts'

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
    <section className={codeSectionStyles().section()}>
      <h2>
        <button
          type="button"
          className={codeSectionStyles().summary()}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span>In the code</span>
          <span className={codeSectionStyles().count()}>{count}</span>
          <ChevronDown size={16} aria-hidden className={codeSectionStyles().chevron({ open })} />
        </button>
      </h2>
      {open ? children : null}
    </section>
  )
}
