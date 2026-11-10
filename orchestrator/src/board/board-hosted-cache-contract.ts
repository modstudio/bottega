// concern: hosted-board-read-cache-contract
/** Public shapes produced by the hosted board read cache. */

export type HostedCacheNotice = {
  id: string
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: import('../../../shared/board-purpose.ts').BoardPurpose
  reportReplySuccessor?: boolean
  successorHeld?: boolean
  threadTitle?: string
}
