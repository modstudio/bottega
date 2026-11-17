// concern: hosted-question-step
/** Binds hosted workflow questions to the step where they were first asked. */

import type { SQL } from 'bun'
import { sql as drizzleSql } from 'drizzle-orm'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { question as questionRecord } from '../../../shared/record/schema-question.ts'
import { RecordQuestionError } from './record-question-contract.ts'
import { questionValues } from './record-sync-service.ts'

/** A rewrite keeps the step a question was first asked on; only an unbound row takes the new one. */
export const QUESTION_STEP_CONFLICT_SET = {
  workflowStepOrdinal: drizzleSql`COALESCE(${questionRecord.workflowStepOrdinal}, excluded.workflow_step_ordinal)`,
  workflowStepSlug: drizzleSql`COALESCE(${questionRecord.workflowStepSlug}, excluded.workflow_step_slug)`,
}

export const RECORD_QUESTION_STEP_COLUMNS =
  'COALESCE(q.workflow_step_ordinal,stage.active_ordinal + 1) workflow_step_ordinal,COALESCE(q.workflow_step_slug,stage.active_slug) workflow_step_slug'

/** The inbox ordinal is zero-based like the local cursor's, so the stored one-based step is shifted back. */
export const RECORD_QUESTION_INBOX_STEP_COLUMNS =
  'COALESCE(q.workflow_step_ordinal - 1,stage.active_ordinal) ordinal,COALESCE(q.workflow_step_slug,stage.active_slug) step_slug'

export async function questionValuesForWrite(
  tx: SQL,
  payload: Record<string, unknown>,
  projectId: string | null,
  workflowTaskId: string | null,
  workflowCursorRecordId: string | null,
  requireWorkflowStep = false,
) {
  const workflowStep = workflowCursorRecordId
    ? (
        (await tx`
        SELECT active_ordinal,active_slug FROM task_flow_stage
         WHERE id=${workflowCursorRecordId}::uuid
      `) as Array<{ active_ordinal: number | string; active_slug: string }>
      )[0]
    : undefined
  if (workflowCursorRecordId && requireWorkflowStep && !workflowStep)
    throw new RecordQuestionError(
      `workflow cursor ${workflowCursorRecordId} is absent from the question's destination space; ask through the cursor's project with \`${PLATFORM_SLUG} workflow await\` so the question is written to the space that holds the cursor`,
      409,
    )
  return {
    ...questionValues(payload, projectId, workflowTaskId),
    workflowStepOrdinal: workflowStep ? Number(workflowStep.active_ordinal) + 1 : null,
    workflowStepSlug: workflowStep?.active_slug ?? null,
  }
}
