import { WaitingBadge as WaitingBadgeView } from '@bottega/hub-views/waiting-badge'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { operatorInboxPath } from '../../../../shared/operator-inbox.ts'

export type WaitingBadgeItem = { kind: 'question' | 'workflow'; id: number }

export function WaitingBadge({ item }: { item: WaitingBadgeItem }) {
  return (
    <WaitingBadgeView
      renderLink={(children: ReactNode, className: string) => (
        <Link
          to={operatorInboxPath(item.kind, item.id)}
          className={className}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </Link>
      )}
    />
  )
}
