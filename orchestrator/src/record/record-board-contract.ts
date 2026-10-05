// concern: record-board-contract
/** Hosted board JSON contract. Must not know SQL or local stores. */

export const BOARD_CHANGES_PAGE_LIMIT = 100
export const BOARD_MESSAGE_REVISION_LOCK_KEY = 968_000_002

export class RecordBoardError extends Error {
  status: 400 | 403 | 404 | 409 | 429
  constructor(message: string, status: 400 | 403 | 404 | 409 | 429 = 400) {
    super(message)
    this.name = 'RecordBoardError'
    this.status = status
  }
}

export function asBoardError<T>(run: () => T, status: 400 | 403 | 404 | 409 | 429 = 400): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof RecordBoardError) throw error
    throw new RecordBoardError(error instanceof Error ? error.message : String(error), status)
  }
}

type HostedBoardOrigin = {
  kind: string
  session: string | null
  harness: string | null
  project: string | null
  runId: string | null
}

type HostedBoardSenderTag = { kind: 'task' | 'path' | 'topic'; value: string }

type HostedBoardTag = HostedBoardSenderTag & { origin: 'sender' | 'inferred' }

export type HostedBoardMessage = {
  id: string
  kind: string
  threadRootId: string | null
  title: string | null
  body: string
  audience: string | null
  origin: HostedBoardOrigin
  senderTags: HostedBoardSenderTag[]
  createdAt: string
  expiresAt: string | null
  withdrawnAt: string | null
  state: string | null
  acceptedReplyId: string | null
  acceptedBy: string | null
  acceptedAt: string | null
  noteId: string | null
  notePendingError: string | null
  revision: string
  scopeProjectIds: string[]
  recipientUserIds: string[]
  claimId: string | null
  authorUserId: string
  authorSession: string | null
  ackRequired: boolean
  ackDeadline: string | null
}

export type HostedBoardReply = {
  id: string
  body: string
  origin: HostedBoardOrigin
  createdAt: string
}

export type HostedBoardThread = {
  root: HostedBoardMessage
  replies: HostedBoardReply[]
}

export type HostedBoardReceipt = {
  messageId: string
  readerUserId: string
  readerSession: string
  audienceAtPosting: boolean
  deliveredAt: string | null
  acknowledgedAt: string | null
}

export type HostedBoardChange = {
  message: HostedBoardMessage
  tags: HostedBoardTag[]
  receipts: HostedBoardReceipt[]
}

export type HostedBoardStatus = {
  message: HostedBoardMessage
  receipts: HostedBoardReceipt[]
}

export type HostedBoardClaim = {
  id: string
  project: string
  subject: { kind: 'task' | 'path' | 'resource'; value: string }
  holder: string
  note: string | null
  runId: string | null
  takenAt: string
  renewedAt: string
  lapsesAt: string
  live: boolean
  closedAt: string | null
  closeReason: string | null
  previousClaimIds: string[]
  supersededByClaimId: string | null
}

export type HostedBoardCreateContent = {
  kind: string
  audience: string | null
  title: string | null
  body: string
  ackRequired: boolean
  ackDeadline: string | null
  expiresAt: string | null
  threadRootId: string | null
  scopeProjectIds: string[]
  recipientUserIds: string[]
  claimId: string | null
  senderTags: HostedBoardSenderTag[]
}

export type HostedBoardPostInput = {
  id: string
  kind: 'notice' | 'question'
  audience: string
  title: string
  body: string
  ackRequired?: boolean
  ackDeadline?: string | null
  expiresAt: string
  task?: string
  paths?: string[]
  topics?: string[]
  authorSession?: string | null
  authorHarness?: string | null
  authorMachineId?: string | null
  authorRunId?: string | null
  project?: string
  currentTaskKey?: string | null
}

export type HostedBoardReplyInput = {
  id: string
  body: string
  authorSession?: string | null
  authorHarness?: string | null
  authorMachineId?: string | null
  authorRunId?: string | null
}

export type HostedBoardSessionInput = { authorSession?: string | null }

export type HostedBoardAcceptInput = HostedBoardSessionInput & { replyId: string }

export type HostedBoardFilingCompleteInput = HostedBoardSessionInput & { noteId: string }

export type HostedBoardFilingFailInput = HostedBoardSessionInput & { error: string }

export type HostedBoardReceiptInput = {
  messageId: string
  readerSession: string
  audienceAtPosting: boolean
  delivered?: boolean
  acknowledged?: boolean
}

export type HostedBoardTakeClaimInput = {
  id: string
  project: string
  subject: string
  durationMs?: number
  runId?: string | null
  note?: string
  holderSession?: string | null
}
