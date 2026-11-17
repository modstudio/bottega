// concern: workflows
/** Names the recovery for an open cursor question whose workflow step was never bound. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export function strandedWorkflowQuestionRemedy(
  questions: readonly Record<string, unknown>[],
): string | null {
  const question = questions.find(
    (row) =>
      row.workflow_step_ordinal === null &&
      row.workflow_step_slug === null &&
      row.answered_at === null &&
      row.closed_at === null,
  )
  if (!question) return null
  return `question ${String(question.number)} (record ${String(question.record_id)}) is open on this cursor but carries no step, so no workflow verb can rule on it; close it with \`${PLATFORM_SLUG} question close ${String(question.record_id)} --reason <why>\`, then record the question again with \`${PLATFORM_SLUG} workflow await\``
}
