// concern: run-answer-liveness
/** Knows only whether an open question belongs to a live, answerable chain. */
export function answerRunLivenessRefusal(
  root: { status: string; voided: boolean },
  open: readonly { owner_status: string }[],
): string | null {
  if (root.voided) return 'voided'
  if (
    open.some(
      (question) => question.owner_status === 'running' || question.owner_status === 'asking',
    )
  )
    return null
  return open[0]?.owner_status ?? null
}
