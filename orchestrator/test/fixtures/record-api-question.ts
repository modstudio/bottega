import type { RecordApiClient } from '../../src/record/record-api-client.ts'
import type { QuestionReadInput } from '../../src/record/record-question-contract.ts'
import type { MemoryTaskFlowInput } from './record-api-task-flow.ts'

export type MemoryQuestionReadCounts = Record<
  'questions' | 'memberships',
  Partial<Record<QuestionReadInput['read'], number>>
>

export type MemoryQuestionInput = Pick<
  MemoryTaskFlowInput,
  'taskFlowProjectSpaces' | 'taskFlowStages'
> & {
  questions?: Record<string, unknown>[]
  questionReadCounts?: MemoryQuestionReadCounts
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
): Pick<RecordApiClient, 'sync' | 'readQuestions' | 'readMembershipQuestions' | 'writeQuestion'> {
  const questions = input.questions ?? []
  const read = async (
    selector: QuestionReadInput,
    route: keyof MemoryQuestionReadCounts,
    destination?: Parameters<NonNullable<RecordApiClient['readQuestions']>>[1],
  ) => {
    const routeCounts = input.questionReadCounts?.[route]
    if (routeCounts) routeCounts[selector.read] = (routeCounts[selector.read] ?? 0) + 1
    const keyed = ['by-id', 'for-run', 'for-runs', 'for-cursor', 'open-for-cursors'].includes(
      selector.read,
    )
    const selected = questions.filter((row) => {
      if (destination && row.space_id && row.space_id !== destination.destinationSpaceId)
        return false
      if (selector.read === 'by-id') return selector.ids.includes(String(row.id ?? row.record_id))
      if (selector.read === 'by-number') return Number(row.number) === selector.number
      if (selector.read === 'for-run') return (row.run_id ?? row.runId) === selector.runId
      if (selector.read === 'open-for-tasks')
        return (
          selector.taskRecordIds.includes(
            String(row.workflow_task_id ?? row.workflowTaskId ?? row.workflow_task_record_id),
          ) &&
          (row.answered_at ?? row.answeredAt) == null &&
          (row.closed_at ?? row.closedAt) == null
        )
      if (selector.read === 'for-cursor')
        return (
          (row.workflow_cursor_record_id ?? row.workflowCursorRecordId) ===
          selector.workflowCursorRecordId
        )
      if (selector.read === 'open-for-cursors')
        return (
          selector.workflowCursorRecordIds.includes(
            String(row.workflow_cursor_record_id ?? row.workflowCursorRecordId),
          ) &&
          (row.answered_at ?? row.answeredAt) == null &&
          (row.closed_at ?? row.closedAt) == null
        )
      return true
    })
    const rows =
      selector.read === 'open-for-cursors'
        ? [
            ...new Map(
              selected
                .sort((left, right) => Number(right.number) - Number(left.number))
                .map((row) => [
                  String(row.workflow_cursor_record_id ?? row.workflowCursorRecordId),
                  row,
                ]),
            ).values(),
          ]
        : selected
    const items = rows.map((row) => {
      const hosted = hostedQuestionRow(row)
      const stageRow = input.taskFlowStages?.find(
        ({ stage }) => stage.id === (row.workflowCursorRecordId ?? row.workflow_cursor_record_id),
      )
      const stage = stageRow?.stage
      const spaceId =
        hosted.space_id ??
        stageRow?.space_id ??
        (stage ? input.taskFlowProjectSpaces?.[stage.projectId] : undefined)
      return {
        ...hosted,
        ...((keyed || route === 'memberships') && spaceId ? { space_id: spaceId } : {}),
        ...(stage && hosted.project === undefined ? { project: stage.projectName } : {}),
        workflow_step_ordinal:
          hosted.workflow_step_ordinal ?? (stage ? stage.activeOrdinal + 1 : null),
        workflow_step_slug: hosted.workflow_step_slug ?? stage?.activeSlug ?? null,
      }
    })
    return { items }
  }
  return {
    async sync(request) {
      return {
        results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
      }
    },
    readQuestions: (selector, destination) => read(selector, 'questions', destination),
    readMembershipQuestions: (selector) => read(selector, 'memberships'),
    async writeQuestion(_intent, body, destination) {
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
        space_id: destination.destinationSpaceId,
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
