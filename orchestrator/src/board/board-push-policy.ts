// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

import type { BoardPurpose } from '../../../shared/board-purpose.ts'

export type BoardPushDecision = 'withheld' | 'ordinary' | 'acknowledgement'
export type BoardReaderStart = string | null | 'unbounded'

export function lateDeliveryDecision(input: {
  purpose: BoardPurpose
  inAudience: boolean
  expired: boolean
  hasReceipt: boolean
  sessionBeganBeforePost: boolean
}): 'deliver' | 'skip' {
  if (!input.inAudience || input.expired || input.hasReceipt || !input.sessionBeganBeforePost)
    return 'skip'
  return input.purpose === 'request' || input.purpose === 'standing' ? 'deliver' : 'skip'
}

export function reportReplySuccessorDecision(input: {
  rootAuthorLive: boolean
  readerIsArchitect: boolean
  readerProject: string
  rootProject: string | null
  readerIsParticipant: boolean
  successorAlreadyReceived: boolean
}): boolean {
  return (
    !input.rootAuthorLive &&
    !input.readerIsParticipant &&
    !input.successorAlreadyReceived &&
    input.readerIsArchitect &&
    input.rootProject !== null &&
    input.readerProject === input.rootProject
  )
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

function sessionBeganBeforePost(readerBeganAt: BoardReaderStart, postedAt: string): boolean {
  return readerBeganAt !== null && readerBeganAt !== 'unbounded' && readerBeganAt <= postedAt
}

export function boardPushDecision(input: {
  acknowledgementRequired: boolean
  postedAt: string
  acknowledgementDeadline: string | null
  expiresAt: string | null
  purpose?: BoardPurpose
  readerBeganAt: BoardReaderStart
  clock: number
  inAudience?: boolean
  hasReceipt?: boolean
  reportReplySuccessor?: boolean
}): BoardPushDecision {
  if (input.hasReceipt || input.inAudience === false) return 'withheld'
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.clock) return 'withheld'
  if (input.reportReplySuccessor) return 'ordinary'
  if (input.acknowledgementRequired)
    return acknowledgementPushDecision({
      acknowledgementDeadline: input.acknowledgementDeadline,
      readerBeganAt: input.readerBeganAt,
      postedAt: input.postedAt,
      clock: input.clock,
    })
  if (
    lateDeliveryDecision({
      purpose: input.purpose ?? 'information',
      inAudience: true,
      expired: false,
      hasReceipt: false,
      sessionBeganBeforePost: sessionBeganBeforePost(input.readerBeganAt, input.postedAt),
    }) === 'deliver'
  )
    return 'ordinary'
  if (
    input.readerBeganAt !== null &&
    input.readerBeganAt !== 'unbounded' &&
    input.purpose !== 'standing' &&
    input.postedAt < input.readerBeganAt
  )
    return 'withheld'
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
  },
>(
  readerBeganAt: BoardReaderStart,
  candidates: T[],
  clock: number,
): { notices: T[]; withheldOlderCount: number } {
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
    return [notice]
  })
  return { notices, withheldOlderCount: candidates.length - notices.length }
}

export const missingReaderStartWarning = (reader: string): string =>
  `Board reader ${reader} has no recorded start; no messages were withheld by age.`
