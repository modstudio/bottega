import type { ReactNode } from 'react'
import { emptyStateStyles } from './empty-state.styles.ts'

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
    <div className={emptyStateStyles().slot1()}>
      <div className={emptyStateStyles().slot2()}>{title}</div>
      {hint ? <div className={emptyStateStyles().slot3()}>{hint}</div> : null}
      {action ? <div className={emptyStateStyles().slot4()}>{action}</div> : null}
    </div>
  )
}
