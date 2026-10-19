import { Badge } from '@bottega/hub-ui/badge'
import type { WaitingRow } from '@bottega/hub-views/work-list'
import { Link } from '@tanstack/react-router'
import { operatorInboxPath } from '../../../../shared/operator-inbox.ts'

/** A run waiting on the operator, linked to whatever it waits on in the inbox. */
export function WaitingBadge({ item }: { item: WaitingRow }) {
  return (
    <Link to={operatorInboxPath(item.kind, item.id)} onClick={(event) => event.stopPropagation()}>
      <Badge tone="warning">waiting on you</Badge>
    </Link>
  )
}
