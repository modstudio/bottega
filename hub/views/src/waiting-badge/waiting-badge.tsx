import { Badge } from '@bottega/hub-ui/badge'
import type { ReactNode } from 'react'
import { waitingBadgeStyles } from './waiting-badge.styles.ts'

export type WaitingBadgeItem = { kind: 'question' | 'workflow'; id: number }

export function WaitingBadge({
  item,
  renderLink,
}: {
  item: WaitingBadgeItem
  renderLink(children: ReactNode, className: string): ReactNode
}) {
  void item
  return renderLink(<Badge tone="warning">waiting on you</Badge>, waitingBadgeStyles())
}
