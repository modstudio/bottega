import type { ReactNode } from 'react'
import { errorStateStyles } from './error-state.styles.ts'

/** A load failure, what could not be loaded, and the remedy when one is available. */
export function ErrorState({
  title,
  message,
  action,
}: {
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div data-tone="error" className={errorStateStyles().root()}>
      <div className={errorStateStyles().title()}>{title}</div>
      {message ? <div className={errorStateStyles().message()}>{message}</div> : null}
      {action ? <div className={errorStateStyles().action()}>{action}</div> : null}
    </div>
  )
}
