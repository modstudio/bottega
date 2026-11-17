// concern: hosted-board-read-cache-contract
/** Public shapes produced by the hosted board read cache. */

import type { ReplySuccessorNoticeState } from './board-push-policy.ts'

export type HostedCacheNotice = {
  id: string
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: import('../../../shared/board-purpose.ts').BoardPurpose
  threadTitle?: string
} & ReplySuccessorNoticeState
