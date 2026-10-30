// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { boardHeaderValue, type PresenceFact, resolveAudience } from './board-policy.ts'

export type BoardPushDecision = 'withheld' | 'ordinary' | 'acknowledgement'
export type BoardReaderStart = string | null | 'unbounded'
export type DeferredReplySuccessor = { replyRecordId: string; threadTitle: string }

export const DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT = 3
const WITHDRAWAL_DELIVERY_PREFIX = 'withdrawn:'

export const withdrawalDeliveryId = (id: string): string => `${WITHDRAWAL_DELIVERY_PREFIX}${id}`

export const isWithdrawalDeliveryId = (id: string): boolean =>
  id.startsWith(WITHDRAWAL_DELIVERY_PREFIX)

export function withdrawalDeliveryText(input: {
  id: string
  title: string
  withdrawnAt: string
}): string {
  return `WITHDRAWN: "${boardHeaderValue(input.title)}" (${boardHeaderValue(input.id)}) was withdrawn by its author at ${boardHeaderValue(input.withdrawnAt)}; anything you paused for it may resume.`
}

export function withdrawalPending(input: {
  isRoot: boolean
  withdrawnAt: string | null
  deliveredAt: string | null
  authorSession: string | null
  readerSession: string
  alreadyDelivered: boolean
}): boolean {
  return (
    input.isRoot &&
    input.withdrawnAt !== null &&
    input.deliveredAt !== null &&
    input.authorSession !== input.readerSession &&
    !input.alreadyDelivered &&
    Date.parse(input.deliveredAt) < Date.parse(input.withdrawnAt)
  )
}

export function reportReplySuccessorDecision(input: {
  rootAuthorLive: boolean
  rootAuthorReceivedReply: boolean
  readerIsArchitect: boolean
  readerProject: string
  rootProject: string | null
  readerIsParticipant: boolean
  successorClaimed: boolean
  readerBeganAt: string | null
  authorLastActivityAt: number | null
  replyPostedAt: string
}): boolean {
  return (
    !input.rootAuthorLive &&
    !input.rootAuthorReceivedReply &&
    !input.readerIsParticipant &&
    !input.successorClaimed &&
    input.readerIsArchitect &&
    input.rootProject !== null &&
    input.readerProject === input.rootProject &&
    input.readerBeganAt !== null &&
    input.authorLastActivityAt !== null &&
    Date.parse(input.replyPostedAt) > input.authorLastActivityAt &&
    Date.parse(input.readerBeganAt) > input.authorLastActivityAt
  )
}

export function replySuccessorAddressing(input: {
  presence: PresenceFact[]
  reader: string
  rootAuthorSession: string
  rootAuthorReceivedReply: boolean
  rootProject: string | null
  readerIsParticipant: boolean
  successorClaimed: boolean
  readerBeganAt: string | null
  replyPostedAt: string
  now: number
  liveWindowMs: number
}): boolean {
  const readerFact = input.presence.find(
    (row) => row.reader === input.reader && !row.taskAudienceOnly,
  )
  const authorFact = input.presence.find(
    (row) => row.reader === input.rootAuthorSession && !row.taskAudienceOnly,
  )
  return reportReplySuccessorDecision({
    rootAuthorLive: resolveAudience(
      { kind: 'session', value: input.rootAuthorSession },
      input.presence,
      input.now,
      input.liveWindowMs,
    ).includes(input.rootAuthorSession),
    rootAuthorReceivedReply: input.rootAuthorReceivedReply,
    readerIsArchitect: readerFact?.role === 'architect',
    readerProject: readerFact?.project ?? '',
    rootProject: input.rootProject,
    readerIsParticipant: input.readerIsParticipant,
    successorClaimed: input.successorClaimed,
    readerBeganAt: input.readerBeganAt,
    authorLastActivityAt: authorFact?.lastSeen ?? null,
    replyPostedAt: input.replyPostedAt,
  })
}

function acknowledgementPushDecision(input: {
  acknowledgementDeadline: string | null
  readerBeganAt: BoardReaderStart
  postedAt: string
  clock: number
}): BoardPushDecision {
  if (
    input.acknowledgementDeadline !== null &&
    Date.parse(input.acknowledgementDeadline) <= input.clock
  )
    return 'withheld'
  if (input.readerBeganAt === null) return 'withheld'
  if (input.readerBeganAt !== 'unbounded' && input.readerBeganAt > input.postedAt) return 'withheld'
  return 'acknowledgement'
}

function olderThanReader(
  readerBeganAt: BoardReaderStart,
  postedAt: string,
  purpose?: BoardPurpose,
): boolean {
  return (
    readerBeganAt !== null &&
    readerBeganAt !== 'unbounded' &&
    purpose !== 'standing' &&
    postedAt < readerBeganAt
  )
}

export function boardPushDecision(input: {
  acknowledgementRequired: boolean
  postedAt: string
  acknowledgementDeadline: string | null
  expiresAt: string | null
  purpose?: BoardPurpose
  readerBeganAt: BoardReaderStart
  clock: number
  reportReplySuccessor?: boolean
}): BoardPushDecision {
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.clock) return 'withheld'
  if (input.acknowledgementRequired)
    return acknowledgementPushDecision({
      acknowledgementDeadline: input.acknowledgementDeadline,
      readerBeganAt: input.readerBeganAt,
      postedAt: input.postedAt,
      clock: input.clock,
    })
  if (olderThanReader(input.readerBeganAt, input.postedAt, input.purpose))
    return input.reportReplySuccessor ? 'ordinary' : 'withheld'
  return 'ordinary'
}

export function selectPushNotices<
  T extends {
    ackRequired: boolean
    ackDeadline: string | null
    createdAt: string
    expiresAt: string | null
    purpose?: BoardPurpose
    reportReplySuccessor?: boolean
    threadTitle?: string
  },
>(
  readerBeganAt: BoardReaderStart,
  candidates: T[],
  clock: number,
  claimReplySuccessors = true,
): {
  notices: T[]
  withheldOlderCount: number
  deferredReplySuccessorCount: number
  deferredReplySuccessors: T[]
} {
  const deferredReplySuccessors: T[] = []
  const notices = candidates.flatMap((notice) => {
    const decision = boardPushDecision({
      acknowledgementRequired: notice.ackRequired,
      postedAt: notice.createdAt,
      acknowledgementDeadline: notice.ackDeadline,
      expiresAt: notice.expiresAt,
      readerBeganAt,
      purpose: notice.purpose,
      clock,
      reportReplySuccessor: notice.reportReplySuccessor,
    })
    if (decision === 'withheld') return []
    if (notice.reportReplySuccessor && !claimReplySuccessors) {
      deferredReplySuccessors.push(notice)
      return []
    }
    return [notice]
  })
  return {
    notices,
    withheldOlderCount: candidates.length - notices.length - deferredReplySuccessors.length,
    deferredReplySuccessorCount: deferredReplySuccessors.length,
    deferredReplySuccessors,
  }
}

export function deferredReplySuccessorWarning(
  replies: DeferredReplySuccessor[],
  deliveryCommand: string,
): string | null {
  if (!replies.length) return null
  const named = replies
    .slice(0, DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT)
    .map(
      (reply) =>
        `"${boardHeaderValue(reply.threadTitle)}" (reply ${boardHeaderValue(reply.replyRecordId)})`,
    )
    .join(', ')
  const remaining = replies.length - DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT
  const more = remaining > 0 ? `, and ${remaining} more` : ''
  return `Deferred report replies: ${named}${more}. Each is held, not lost. The next board delivery that can claim it delivers it. Run ${boardHeaderValue(deliveryCommand)} to deliver it now.`
}

export const missingReaderStartWarning = (reader: string): string =>
  `Board reader ${reader} has no recorded start; no messages were withheld by age.`
