import { Badge } from '@/ui/badge/badge'
import type { DocStatus } from '../../../../shared/docs.ts'

export function DocStatusBadge({ status = 'current' }: { status?: DocStatus }) {
  return status === 'current' ? null : (
    <Badge icon={false} data-doc-status={status}>
      {status}
    </Badge>
  )
}
