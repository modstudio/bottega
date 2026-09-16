// concern: filed-issue queue failure decision
/** A queue failure is recoverable only after both durable close-out writes succeeded. */

export function filedIssueQueueFailureAction(input: {
  queueMode: boolean
  failureRecorded: boolean
  movedToReview: boolean
}): 'continue' | 'throw' {
  return input.queueMode && input.failureRecorded && input.movedToReview ? 'continue' : 'throw'
}
