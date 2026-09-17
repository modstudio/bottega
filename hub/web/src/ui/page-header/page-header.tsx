import type { ReactNode } from 'react'

/** The page's name, a line of standing context, and the page's own controls. */
export function PageHeader({
  title,
  subtitle,
  subtitleTitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** The full context behind a shortened subtitle, on hover. */
  subtitleTitle?: string
  actions?: ReactNode
}) {
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
