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
    <div className={emptyStateStyles().root()}>
      <div className={emptyStateStyles().title()}>{title}</div>
      {hint ? <div className={emptyStateStyles().hint()}>{hint}</div> : null}
      {action ? <div className={emptyStateStyles().action()}>{action}</div> : null}
    </div>
  )
}
