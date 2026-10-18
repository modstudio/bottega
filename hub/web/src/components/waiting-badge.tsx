import { Badge } from '@bottega/hub-ui/badge'
import { Link } from '@tanstack/react-router'
import { operatorInboxPath } from '../../../../shared/operator-inbox.ts'

type WaitingBadgeItem = { kind: 'question' | 'workflow'; id: number }

export function WaitingBadge({ item }: { item: WaitingBadgeItem }) {
  return (
    <Link to={operatorInboxPath(item.kind, item.id)} onClick={(event) => event.stopPropagation()}>
      <Badge tone="warning">waiting on you</Badge>
    </Link>
  )
}
