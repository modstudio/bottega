import type { WaitingBadgeItem } from '@bottega/hub-views/waiting-badge'
import { WaitingBadge as WaitingBadgeView } from '@bottega/hub-views/waiting-badge'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { operatorInboxPath } from '../../../../shared/operator-inbox.ts'

export function WaitingBadge({ item }: { item: WaitingBadgeItem }) {
  return (
    <WaitingBadgeView
      item={item}
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
