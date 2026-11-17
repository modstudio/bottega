import type { RecordApiClient } from '../../src/record/record-api-client.ts'
import type { MemoryTaskFlowInput } from './record-api-task-flow.ts'

type MemoryQuestionInput = Pick<MemoryTaskFlowInput, 'taskFlowStages'> & {
  questions?: Record<string, unknown>[]
}

function hostedQuestionRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const recordKey =
        key === 'runId'
          ? 'run_record_id'
          : key === 'workflowTaskId'
            ? 'workflow_task_record_id'
            : key === 'projectId'
              ? 'project_record_id'
              : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
      return [recordKey, value]
    }),
  )
}

export function memoryQuestionClient(
  input: MemoryQuestionInput,
): Pick<RecordApiClient, 'sync' | 'readQuestions' | 'writeQuestion'> {
  const questions = input.questions ?? []
  return {
    async sync(request) {
      return {
        results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
      }
    },
    async readQuestions(selector) {
      const items = questions
        .filter((row) => {
          if (selector.read === 'by-id')
            return selector.ids.includes(String(row.id ?? row.record_id))
          if (selector.read === 'by-number') return Number(row.number) === selector.number
          if (selector.read === 'for-run') return (row.run_id ?? row.runId) === selector.runId
          if (selector.read === 'for-cursor')
            return (
              (row.workflow_cursor_record_id ?? row.workflowCursorRecordId) ===
              selector.workflowCursorRecordId
            )
          return true
        })
        .map((row) => {
          const hosted = hostedQuestionRow(row)
          const stage = input.taskFlowStages?.find(
            ({ stage }) =>
              stage.id === (row.workflowCursorRecordId ?? row.workflow_cursor_record_id),
          )?.stage
          return {
            ...hosted,
            ...(stage && hosted.project === undefined ? { project: stage.projectName } : {}),
            workflow_step_ordinal:
              hosted.workflow_step_ordinal ?? (stage ? stage.activeOrdinal + 1 : null),
            workflow_step_slug: hosted.workflow_step_slug ?? stage?.activeSlug ?? null,
          }
        })
      return { items }
    },
    async writeQuestion(_intent, body) {
      const index = questions.findIndex((row) => (row.id ?? row.record_id) === body.question.id)
      const number =
        body.question.number ??
        questions.reduce((highest, row) => Math.max(highest, Number(row.number ?? 0)), 0) + 1
      const existing = index === -1 ? undefined : questions[index]
      const stage = input.taskFlowStages?.find(
        ({ stage }) => stage.id === body.question.workflowCursorRecordId,
      )?.stage
      const stored = {
        ...body.question,
        number,
        workflowStepOrdinal:
          existing?.workflowStepOrdinal ??
          existing?.workflow_step_ordinal ??
          (stage ? stage.activeOrdinal + 1 : null),
        workflowStepSlug:
          existing?.workflowStepSlug ?? existing?.workflow_step_slug ?? stage?.activeSlug ?? null,
      }
      if (index === -1) questions.push(stored)
      else questions[index] = stored
      return {
        id: body.question.id,
        number,
        revision: body.question.revision,
        applied: true,
      }
    },
  }
}
