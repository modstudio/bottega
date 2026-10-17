import type { OperatorWaitingItem } from '@bottega/hub-data/client'
import { Badge } from '@bottega/hub-ui/badge'
import { Link } from '@tanstack/react-router'
import { operatorInboxPath } from '../../../../shared/operator-inbox.ts'

export function WaitingBadge({ item }: { item: OperatorWaitingItem }) {
  return (
    <Link to={operatorInboxPath(item.kind, item.id)} onClick={(event) => event.stopPropagation()}>
      <Badge tone="warning">waiting on you</Badge>
    </Link>
  )
}
