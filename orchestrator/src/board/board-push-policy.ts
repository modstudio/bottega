// concern: board-push-policy
/** Decides whether a board message belongs in a reader's pushed delivery. */

export function messageIsDueForPush(input: {
  postedAt: string
  readerBeganAt: string
  acknowledgementRequired: boolean
}): boolean {
  return input.acknowledgementRequired || input.postedAt >= input.readerBeganAt
}
