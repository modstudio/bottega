// concern: run-answer-liveness
/** Knows only whether an open question belongs to a live, answerable chain. */
import { runQuestionOwnerLive } from '../question-store/run-question-write-guard.ts'

export function answerRunLivenessRefusal(
  root: { status: string; voided: boolean },
  open: readonly { owner_status: string }[],
): string | null {
  if (root.voided) return 'voided'
  if (open.some((question) => runQuestionOwnerLive(question.owner_status))) return null
  return open[0]?.owner_status ?? null
}
