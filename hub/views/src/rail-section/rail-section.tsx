import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { railSectionStyles } from './rail-section.styles.ts'

export function RailSection({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string
  count?: ReactNode
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={railSectionStyles().root()}>
      <button
        type="button"
        className={railSectionStyles().button()}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        {count !== undefined ? <span className={railSectionStyles().count()}>{count}</span> : null}
        <ChevronDown
          size={14}
          className={railSectionStyles({ countAbsent: count === undefined, open }).chevron()}
        />
      </button>
      {open ? <div className={railSectionStyles().body()}>{children}</div> : null}
    </section>
  )
}
