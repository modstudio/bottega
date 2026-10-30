// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { type PresenceFact, resolveAudience } from './board-policy.ts'

export type BoardPushDecision = 'withheld' | 'ordinary' | 'acknowledgement'
export type BoardReaderStart = string | null | 'unbounded'
export type DeferredReplySuccessor = { replyRecordId: string; threadTitle: string }

export const DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT = 3

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
    replyRecordId?: string
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
  deferredReplySuccessors: DeferredReplySuccessor[]
} {
  const deferredReplySuccessors: DeferredReplySuccessor[] = []
  const notices = candidates.flatMap((notice) => {
    if (notice.reportReplySuccessor && !claimReplySuccessors) {
      if (notice.replyRecordId === undefined || notice.threadTitle === undefined)
        throw new Error('deferred report reply successor is missing its record id or thread title')
      deferredReplySuccessors.push({
        replyRecordId: notice.replyRecordId,
        threadTitle: notice.threadTitle,
      })
      return []
    }
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
    return [notice]
  })
  return {
    notices,
    withheldOlderCount: candidates.length - notices.length - deferredReplySuccessors.length,
    deferredReplySuccessorCount: deferredReplySuccessors.length,
    deferredReplySuccessors,
  }
}

const warningValue = (value: string): string => value.replace(/[\r\n\u2028\u2029]/g, ' ')

export function deferredReplySuccessorWarning(
  replies: DeferredReplySuccessor[],
  deliveryCommand: string,
): string | null {
  if (!replies.length) return null
  const named = replies
    .slice(0, DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT)
    .map(
      (reply) =>
        `"${warningValue(reply.threadTitle)}" (reply ${warningValue(reply.replyRecordId)})`,
    )
    .join(', ')
  const remaining = replies.length - DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT
  const more = remaining > 0 ? `, and ${remaining} more` : ''
  return `Deferred report replies: ${named}${more}. Each is held, not lost. The next board delivery that can claim it delivers it. Run ${warningValue(deliveryCommand)} to deliver it now.`
}

export const missingReaderStartWarning = (reader: string): string =>
  `Board reader ${reader} has no recorded start; no messages were withheld by age.`
