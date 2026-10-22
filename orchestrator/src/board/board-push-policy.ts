// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { type PresenceFact, resolveAudience } from './board-policy.ts'

export type BoardPushDecision = 'withheld' | 'ordinary' | 'acknowledgement'
export type BoardReaderStart = string | null | 'unbounded'

export function reportReplySuccessorDecision(input: {
  rootAuthorLive: boolean
  readerIsArchitect: boolean
  readerProject: string
  rootProject: string | null
  readerIsParticipant: boolean
  successorAlreadyReceived: boolean
  readerBeganAt: string | null
  authorLastActivityAt: number | null
}): boolean {
  return (
    !input.rootAuthorLive &&
    !input.readerIsParticipant &&
    !input.successorAlreadyReceived &&
    input.readerIsArchitect &&
    input.rootProject !== null &&
    input.readerProject === input.rootProject &&
    input.readerBeganAt !== null &&
    input.authorLastActivityAt !== null &&
    Date.parse(input.readerBeganAt) > input.authorLastActivityAt
  )
}

export function replySuccessorAddressing(input: {
  presence: PresenceFact[]
  reader: string
  rootAuthorSession: string
  rootProject: string | null
  readerIsParticipant: boolean
  successorAlreadyReceived: boolean
  readerBeganAt: string | null
  now: number
  liveWindowMs: number
}): boolean {
  const readerFact = input.presence.find((row) => row.reader === input.reader && !row.taskAudienceOnly)
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
    readerIsArchitect: readerFact?.role === 'architect',
    readerProject: readerFact?.project ?? '',
    rootProject: input.rootProject,
    readerIsParticipant: input.readerIsParticipant,
    successorAlreadyReceived: input.successorAlreadyReceived,
    readerBeganAt: input.readerBeganAt,
    authorLastActivityAt: authorFact?.lastSeen ?? null,
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
