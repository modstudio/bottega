import { Archive, ArrowRightLeft, CircleCheck, type LucideIcon, PencilLine } from 'lucide-react'
import type { DocStatus } from '../../../../shared/docs.ts'

/** One icon per document status, so a draft never looks like a published article. */
export const DOC_STATUS_ICONS: Record<DocStatus, LucideIcon> = {
  draft: PencilLine,
  current: CircleCheck,
  superseded: ArrowRightLeft,
  archived: Archive,
}
