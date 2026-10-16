import type { ReactNode } from 'react'

/** What belongs here, when nothing does yet, and how to get some. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
      <div className="font-medium">{title}</div>
      {hint ? <div className="max-w-md text-sm text-text-muted">{hint}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}
