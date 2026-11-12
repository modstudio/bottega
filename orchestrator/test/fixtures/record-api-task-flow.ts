import { type RecordApiClient, RecordApiRequestError } from '../../src/record/record-api-client.ts'
import type { HostedTaskFlowStageById } from '../../src/record/record-task-flow-contract.ts'

export type MemoryTaskFlowInput = {
  taskFlowStages?: HostedTaskFlowStageById[]
  taskFlowProjectNames?: Record<string, string>
  taskFlowComposeFlowRevision?: number
  taskFlowComposeStageRevision?: number
  taskFlowComposeEnforcement?: string
  taskFlowWorkflowVersionNumbers?: Record<string, number>
  taskFlowCatalogueVersionNumbers?: Record<string, number>
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
    !selector.keyless || !stage.workflowKey,
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
  const stages = [...(input.taskFlowStages ?? [])]
  const applyStageChange = (change: { id: string; values: object }) => {
    const row = stages.find(({ stage }) => stage.id === change.id)
    if (!row) throw new Error(`fixture task-flow stage ${change.id} not found`)
    Object.assign(row.stage, change.values)
    row.stage.revision++
    return row.stage.revision
  }
  const applyFlowChange = (change: { id: string; values: object }) => {
    const rows = stages.filter(({ flow }) => flow.id === change.id)
    if (!rows.length) throw new Error(`fixture task flow ${change.id} not found`)
    const revision = rows[0]!.flow.revision + 1
    for (const row of rows) Object.assign(row.flow, change.values, { revision })
    return revision
  }
  return {
    async composeTaskFlow(payload) {
      const stage = payload.stageInsert!
      const priorFlow = stages.find(({ flow }) => flow.id === stage.flowRecordId)?.flow
      const insertedFlow = payload.flowInsert
      const flow = priorFlow ?? {
        id: insertedFlow!.id,
        projectId: insertedFlow!.projectId,
        taskId: insertedFlow!.taskId,
        taskKey: stage.workflowKey || null,
        state: insertedFlow!.state,
        openStageRecordId: insertedFlow!.openStageRecordId,
        openStageCount: 1,
        openingMachineId: insertedFlow!.openingMachineId,
        updatedMachineId: insertedFlow!.updatedMachineId,
        revision: 1,
        createdAt: insertedFlow!.createdAt,
        updatedAt: insertedFlow!.updatedAt,
      }
      const number =
        stages.reduce((highest, row) => Math.max(highest, row.stage.number ?? 0), 0) + 1
      const stored: HostedTaskFlowStageById = {
        flow: {
          ...flow,
          openStageRecordId: stage.id,
          openStageCount: stages.filter(({ flow: row }) => row.id === flow.id).length + 1,
          revision: input.taskFlowComposeFlowRevision ?? flow.revision,
        },
        stage: {
          ...stage,
          projectName: input.taskFlowProjectNames?.[stage.projectId] ?? 'fixture',
          number,
          workflowKey: stage.workflowKey || null,
          workflowVersionNumber:
            input.taskFlowWorkflowVersionNumbers?.[stage.workflowVersionId] ?? 1,
          catalogueVersionNumber:
            input.taskFlowCatalogueVersionNumbers?.[stage.catalogueVersionId] ?? 1,
          revision: input.taskFlowComposeStageRevision ?? 1,
          enforcement: input.taskFlowComposeEnforcement ?? stage.enforcement,
          obligations: [],
          stepTexts: [],
          textCopies: [],
        },
      }
      for (const row of stages) {
        if (row.flow.id === flow.id) row.flow = stored.flow
      }
      stages.push(stored)
      return {
        stage: { id: stage.id, number },
        revisions: { [flow.id]: stored.flow.revision, [stage.id]: stored.stage.revision },
      }
    },
    async updateTaskFlowStage(payload) {
      return {
        revisions: Object.fromEntries(
          payload.stages.map((change) => [change.id, applyStageChange(change)]),
        ),
      }
    },
    async advanceTaskFlow(payload) {
      return {
        revisions: {
          [payload.stage.id]: applyStageChange(payload.stage),
          ...(payload.flow ? { [payload.flow.id]: applyFlowChange(payload.flow) } : {}),
        },
      }
    },
    async awaitTaskFlowRuling(payload) {
      return { revisions: { [payload.stage.id]: applyStageChange(payload.stage) } }
    },
    async abandonTaskFlow(payload) {
      return {
        revisions: {
          [payload.stage.id]: applyStageChange(payload.stage),
          ...(payload.flow ? { [payload.flow.id]: applyFlowChange(payload.flow) } : {}),
        },
      }
    },
    async adoptTaskFlow(payload) {
      const row = stages.find(({ stage }) => stage.id === payload.stage.id)
      if (!row) throw new Error(`fixture task-flow stage ${payload.stage.id} not found`)
      const revision = applyStageChange({
        id: payload.stage.id,
        values: { lastAdvancedMachineId: payload.updatedMachineId, updatedAt: payload.updatedAt },
      })
      const flowRevision = applyFlowChange({
        id: row.flow.id,
        values: { taskId: payload.taskId, updatedMachineId: payload.updatedMachineId },
      })
      return {
        flowRecordId: row.flow.id,
        revisions: { [row.flow.id]: flowRevision, [row.stage.id]: revision },
      }
    },
    async attachTaskFlowText(payload) {
      for (const text of payload.rows) {
        const row = stages.find(({ stage }) => stage.id === text.stageRecordId)
        if (!row) throw new Error(`fixture task-flow stage ${text.stageRecordId} not found`)
        row.stage.stepTexts ??= []
        row.stage.stepTexts.push(text)
      }
      return { revisions: {} }
    },
    async copyTaskFlowText(payload) {
      const row = stages.find(({ stage }) => stage.id === payload.row.stageRecordId)
      if (!row) throw new Error(`fixture task-flow stage ${payload.row.stageRecordId} not found`)
      row.stage.textCopies ??= []
      row.stage.textCopies.push(payload.row)
      return { revisions: {} }
    },
    async deleteTaskFlowText(payload) {
      const row = stages.find(({ stage }) => stage.id === payload.stageRecordId)
      if (!row) throw new Error(`fixture task-flow stage ${payload.stageRecordId} not found`)
      row.stage.stepTexts = (row.stage.stepTexts ?? []).filter(
        ({ id }) => !payload.ids.includes(id),
      )
      return { revisions: {} }
    },
    async readTaskFlow(selector) {
      const found = stages.find(({ flow }) =>
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
      const siblings = stages.filter(({ flow }) => flow.id === found.flow.id)
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
      const rows = [...stages]
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
      return stages.find(({ stage }) => stage.id === id) ?? null
    },
    async readTaskFlowText(id) {
      for (const { stage } of stages) {
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
      for (const { stage } of stages) {
        const obligation = stage.obligations?.find((row) => row.id === id)
        if (obligation)
          return { obligation, stage: { id: stage.id, number: stage.number, state: stage.state } }
      }
      return null
    },
    async readTaskFlowProjectReferenceCounts(projectId) {
      const rows = stages.filter(({ stage }) => stage.projectId === projectId)
      return { stages: rows.length, flows: new Set(rows.map(({ flow }) => flow.id)).size }
    },
  }
}
