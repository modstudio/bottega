// concern: hosted-board-read-cache-contract
/** Public shapes produced by the hosted board read cache. */

/** Only a held successor is deferred and named; a candidate-only reply is dropped. */
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
} & (
  | { reportReplySuccessor: true; successorHeld: boolean }
  | { reportReplySuccessor?: false; successorHeld?: never }
)
