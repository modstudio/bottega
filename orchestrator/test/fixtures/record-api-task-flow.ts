import { type RecordApiClient, RecordApiRequestError } from '../../src/record/record-api-client.ts'
import type { HostedTaskFlowStageById } from '../../src/record/record-task-flow-contract.ts'

export type MemoryTaskFlowInput = {
  taskFlowStages?: HostedTaskFlowStageById[]
  taskFlowPageSize?: number
  taskFlowFailedPage?: number
}

type Selector = Parameters<NonNullable<RecordApiClient['listTaskFlowStages']>>[0]

function matches({ stage, flow }: HostedTaskFlowStageById, selector: Selector): boolean {
  const values = [
    selector.projectId === undefined || stage.projectId === selector.projectId,
    selector.number === undefined || stage.number === selector.number,
    selector.sessionId === undefined || stage.sessionId === selector.sessionId,
    !selector.states || selector.states.includes(stage.state),
    selector.taskKey === undefined || flow.taskKey === selector.taskKey,
    selector.workflow === undefined || stage.workflow === selector.workflow,
    selector.mode === undefined || stage.mode === selector.mode,
    selector.workflowKey === undefined || stage.workflowKey === selector.workflowKey,
    !selector.keyless || stage.workflowKey === '',
    !selector.primaryInstance || stage.instanceId === '',
    selector.taskId === undefined || flow.taskId === selector.taskId,
    !selector.unlinked || flow.taskId === null,
    !selector.linked || flow.taskId !== null,
    selector.openedMachineId === undefined || stage.openedMachineId === selector.openedMachineId,
  ]
  return values.every(Boolean)
}

function compare(
  selector: Selector,
  left: HostedTaskFlowStageById,
  right: HostedTaskFlowStageById,
) {
  if (selector.order === 'newest')
    return (
      (right.stage.number ?? -1) - (left.stage.number ?? -1) ||
      right.stage.id.localeCompare(left.stage.id)
    )
  return (
    (left.stage.projectName ?? '').localeCompare(right.stage.projectName ?? '') ||
    (left.stage.number ?? Number.MAX_SAFE_INTEGER) -
      (right.stage.number ?? Number.MAX_SAFE_INTEGER) ||
    left.stage.id.localeCompare(right.stage.id)
  )
}

export function memoryTaskFlowClient(input: MemoryTaskFlowInput): Partial<RecordApiClient> {
  return {
    async readTaskFlow(selector) {
      const found = input.taskFlowStages?.find(({ flow }) =>
        selector.taskId
          ? flow.taskId === selector.taskId
          : selector.flowRecordId
            ? flow.id === selector.flowRecordId
            : flow.taskKey === selector.taskKey,
      )
      if (!found)
        throw new RecordApiRequestError(
          'hosted task flow not found',
          'refused',
          404,
          'task_flow_not_found',
        )
      const siblings = input.taskFlowStages?.filter(({ flow }) => flow.id === found.flow.id) ?? []
      const open = siblings.find(({ stage }) => stage.id === found.flow.openStageRecordId)
      return {
        flow: found.flow,
        stage: open
          ? {
              ...open.stage,
              holder: { id: open.stage.lastAdvancedMachineId, displayName: 'Fixture' },
            }
          : null,
        otherStages: siblings
          .filter(({ stage }) => stage.id !== open?.stage.id)
          .map(({ stage }) => stage),
      }
    },
    async listTaskFlowStages(selector) {
      const rows = [...(input.taskFlowStages ?? [])]
        .filter((row) => matches(row, selector))
        .sort((left, right) => compare(selector, left, right))
      const offset = Number(selector.cursor ?? 0)
      const configuredSize = input.taskFlowPageSize ?? selector.limit ?? 200
      const pageNumber = Math.floor(offset / configuredSize) + 1
      if (pageNumber === input.taskFlowFailedPage)
        throw new Error('fixture task-flow page is unavailable; restore fixture access and retry')
      const size = Math.min(
        selector.limit ?? 200,
        input.taskFlowPageSize ?? Number.MAX_SAFE_INTEGER,
      )
      const items = rows.slice(offset, offset + size)
      const next = offset + items.length
      return {
        items,
        truncated: next < rows.length,
        nextCursor: next < rows.length ? String(next) : null,
      }
    },
    async readTaskFlowStage(id) {
      return input.taskFlowStages?.find(({ stage }) => stage.id === id) ?? null
    },
    async readTaskFlowText(id) {
      for (const { stage } of input.taskFlowStages ?? []) {
        const text = stage.stepTexts?.find((row) => row.id === id)
        if (text)
          return {
            text,
            stage: { id: stage.id, number: stage.number },
            copy: stage.textCopies?.find((row) => row.workflowTextRecordId === id) ?? null,
          }
      }
      return null
    },
    async readTaskFlowObligation(id) {
      for (const { stage } of input.taskFlowStages ?? []) {
        const obligation = stage.obligations?.find((row) => row.id === id)
        if (obligation)
          return { obligation, stage: { id: stage.id, number: stage.number, state: stage.state } }
      }
      return null
    },
    async readTaskFlowProjectReferenceCounts(projectId) {
      const rows = input.taskFlowStages?.filter(({ stage }) => stage.projectId === projectId) ?? []
      return { stages: rows.length, flows: new Set(rows.map(({ flow }) => flow.id)).size }
    },
  }
}
