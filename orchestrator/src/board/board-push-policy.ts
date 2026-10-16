// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

import type { BoardPurpose } from '../../../shared/board-purpose.ts'

export type BoardPushDecision = 'withheld' | 'ordinary' | 'acknowledgement'
export type BoardReaderStart = string | null | 'unbounded'

export function boardPushDecision(input: {
  acknowledgementRequired: boolean
  postedAt: string
  acknowledgementDeadline: string | null
  expiresAt: string | null
  purpose?: BoardPurpose
  readerBeganAt: BoardReaderStart
  clock: number
}): BoardPushDecision {
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.clock) return 'withheld'
  if (input.acknowledgementRequired) {
    if (
      input.acknowledgementDeadline !== null &&
      Date.parse(input.acknowledgementDeadline) <= input.clock
    )
      return 'withheld'
    if (input.readerBeganAt === null) return 'withheld'
    if (input.readerBeganAt !== 'unbounded' && input.readerBeganAt > input.postedAt)
      return 'withheld'
    return 'acknowledgement'
  }
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
    })
    if (decision === 'withheld') return []
    return [notice]
  })
  return { notices, withheldOlderCount: candidates.length - notices.length }
}

export const missingReaderStartWarning = (reader: string): string =>
  `Board reader ${reader} has no recorded start; no messages were withheld by age.`
