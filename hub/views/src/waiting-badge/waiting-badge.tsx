import { Badge } from '@bottega/hub-ui/badge'
import type { ReactNode } from 'react'
import { waitingBadgeStyles } from './waiting-badge.styles.ts'

/** The badge a waiting run wears; the route renders the link to whatever is waiting. */
export function WaitingBadge({
  renderLink,
}: {
  renderLink(children: ReactNode, className: string): ReactNode
}) {
  return renderLink(<Badge tone="warning">waiting on you</Badge>, waitingBadgeStyles())
}
