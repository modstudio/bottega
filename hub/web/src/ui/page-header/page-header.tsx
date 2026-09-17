import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTopbarSlot } from '../dom/topbar-slot'

type PageHeaderProps = {
  title: ReactNode
  subtitle?: ReactNode
  /** The full context behind a shortened subtitle, on hover. */
  subtitleTitle?: string
  actions?: ReactNode
}

/**
 * The page's name, a line of standing context, and the page's own controls.
 * On a desk they sit in the app's top bar, so the page opens on its content; on
 * a phone, where the bar holds the menu, they open the page.
 */
export function PageHeader({ title, subtitle, subtitleTitle, actions }: PageHeaderProps) {
  const slot = useTopbarSlot()
  if (slot) {
    return createPortal(
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="shrink-0 font-semibold text-lg">{title}</h1>
          {subtitle ? (
            <span
              className="hidden truncate text-sm text-text-muted lg:inline"
              title={subtitleTitle}
            >
              {subtitle}
            </span>
          ) : null}
        </div>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>,
      slot,
    )
  }
  return (
    <header className="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-6 pb-5">
      <div className="min-w-0">
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        {subtitle ? (
          <div className="mt-1 truncate text-sm text-text-muted" title={subtitleTitle}>
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** A heading that opens a section of a page, with optional right-aligned detail. */
export function SectionTitle({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="mt-8 mb-3 flex items-baseline justify-between gap-4">
      <h2 className="font-semibold text-md">{children}</h2>
      {detail ? <span className="text-right text-sm text-text-muted">{detail}</span> : null}
    </div>
  )
}
