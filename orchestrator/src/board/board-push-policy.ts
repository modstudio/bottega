// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

export function messageIsDueForPush(input: { postedAt: string; readerBeganAt: string }): boolean {
  return input.postedAt >= input.readerBeganAt
}

export function selectPushNotices<T extends { createdAt: string }>(
  readerBeganAt: string | null,
  candidates: T[],
): { notices: T[]; withheldOlderCount: number } {
  if (readerBeganAt === null) return { notices: candidates, withheldOlderCount: 0 }
  const notices = candidates.filter((notice) =>
    messageIsDueForPush({ postedAt: notice.createdAt, readerBeganAt }),
  )
  return { notices, withheldOlderCount: candidates.length - notices.length }
}

export const missingReaderStartWarning = (reader: string): string =>
  `Board reader ${reader} has no recorded start; no messages were withheld by age.`
