import { Link } from '@tanstack/react-router'
import { Badge } from '@/ui/badge/badge'
import { operatorInboxPath } from '../../../../shared/operator-inbox.ts'
import type { OperatorWaitingItem } from '../../../src/orch.ts'

export function WaitingBadge({ item }: { item: OperatorWaitingItem }) {
  return (
    <Link to={operatorInboxPath(item.kind, item.id)} onClick={(event) => event.stopPropagation()}>
      <Badge tone="warning">waiting on you</Badge>
    </Link>
  )
}
