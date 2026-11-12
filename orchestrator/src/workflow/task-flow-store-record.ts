// concern: hosted task-flow read adapter
/** Converts hosted task-flow reads to the workflow read-port row shapes. */

import type { Database } from 'bun:sqlite'
import { RecordApiRequestError, recordApiClient } from '../record/record-api-client.ts'
import type { RecordRequestDestination } from '../record/record-api-client-paths.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import {
  type HostedTaskFlow,
  type HostedTaskFlowStageById,
  type HostedTaskFlowStageList,
  RECORD_TASK_FLOW_NOT_FOUND_CODE,
  TASK_FLOW_STAGE_LIST_LIMIT_MAX,
} from '../record/record-task-flow-contract.ts'
import type { TaskFlowReadStore } from './task-flow-store.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'
import type {
  TaskFlowObligationRow,
  TaskFlowOpenObligationRow,
  TaskFlowStageCursorRow,
  TaskFlowTextRow,
} from './task-flow-store-types.ts'
import { workflowReadSpaceFor } from './workflow-read-space.ts'

type ListedItem = HostedTaskFlowStageList['items'][number]
type HostedStage = HostedTaskFlowStageById['stage']
type StageListSelector = Omit<
  Parameters<NonNullable<RecordTaskFlowClient['listTaskFlowStages']>>[0],
  'cursor' | 'limit'
>

function required<T>(value: T | null | undefined, field: string): T {
  if (value == null)
    throw new Error(
      `hosted task-flow stage has no ${field}; repair the hosted task-flow row, then retry`,
    )
  return value
}

function stageRow(
  item: ListedItem,
  includeOpenStageCount = true,
): TaskFlowStageCursorRow & { open_stage_count?: number } {
  const { stage, flow } = item
  return {
    id: required(stage.number, 'number'),
    record_id: stage.id,
    project: required(stage.projectName, 'project name'),
    workflow_slug: stage.workflow,
    mode_slug: stage.mode,
    workflow_key: stage.workflowKey ?? '',
    task_record_id: flow.taskId,
    // SQLite cannot persist a taskless flow, so preserve the port's existing taskless row shape.
    task_flow_record_id: flow.taskId === null ? null : stage.flowRecordId,
    instance_id: stage.instanceId ?? '',
    session_id: stage.sessionId ?? null,
    ordinal: stage.activeOrdinal,
    step_slug: stage.activeSlug,
    state: stage.state,
    workflow_version_record_id: stage.workflowVersionId,
    catalogue_version_record_id: stage.catalogueVersionId,
    workflow_version: required(stage.workflowVersionNumber, 'workflow version number'),
    catalogue_version: required(stage.catalogueVersionNumber, 'catalogue version number'),
    args: JSON.stringify(stage.arguments),
    autonomy: stage.autonomy ?? null,
    closed: JSON.stringify(stage.closedStepNotes),
    question: stage.question ?? null,
    total_steps: stage.totalSteps,
    created_at: stage.createdAt,
    updated_at: stage.updatedAt,
    enforcement: required(
      stage.enforcement,
      'enforcement mode',
    ) as TaskFlowStageCursorRow['enforcement'],
    opened_machine_id: stage.openedMachineId,
    taken_over_from_machine_id: stage.takenOverFromMachineId,
    last_advanced_machine_id: stage.lastAdvancedMachineId,
    revision: stage.revision,
    ...(includeOpenStageCount ? { open_stage_count: flow.openStageCount } : {}),
  }
}

function stageItem(result: HostedTaskFlowStageById): ListedItem {
  return { stage: result.stage, flow: result.flow }
}

function textRow(text: NonNullable<HostedStage['stepTexts']>[number]): TaskFlowTextRow {
  return {
    id: text.id,
    cursor_record_id: text.stageRecordId,
    step_ordinal: text.stepOrdinal,
    step_slug: text.stepSlug,
    body: text.body,
  }
}

function openObligationRow(
  obligation: NonNullable<HostedStage['obligations']>[number],
  cursorNumber: number,
): TaskFlowOpenObligationRow {
  return {
    id: obligation.id,
    floor: obligation.floor,
    require_pull_request: Number(obligation.requirePullRequest),
    operator_ruling: Number(obligation.operatorRuling),
    expected_exit_code: obligation.expectedExitCode,
    expected_status: obligation.expectedStatus,
    floor_deferrable: Number(obligation.floorDeferrable),
    cursor_number: cursorNumber,
    stepOrdinal: obligation.stepOrdinal,
    stepSlug: obligation.stepSlug,
  }
}

function stageListFailure(error: unknown, page: number): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(
    `hosted task-flow stage list page ${page} failed: ${detail}; restore hosted record access and retry`,
    { cause: error },
  )
}

/** Reads every stage-list page or refuses the whole read. */
async function listAllTaskFlowStages(
  client: RecordTaskFlowClient,
  selector: StageListSelector,
  destination?: RecordRequestDestination,
): Promise<ListedItem[]> {
  const items: ListedItem[] = []
  let cursor: string | undefined
  let page = 1
  for (;;) {
    let result: HostedTaskFlowStageList
    try {
      const list = client.listTaskFlowStages
      if (!list)
        throw new Error('record API predates task-flow stage lists; release hosted-api, then retry')
      result = await list(
        { ...selector, cursor, limit: TASK_FLOW_STAGE_LIST_LIMIT_MAX },
        destination,
      )
    } catch (error) {
      throw stageListFailure(error, page)
    }
    items.push(...result.items)
    if (!result.nextCursor) return items
    cursor = result.nextCursor
    page++
  }
}

class RecordTaskFlowReadStore implements TaskFlowReadStore {
  private readonly local: TaskFlowReadStore
  private readonly database: Database
  private readonly client: RecordTaskFlowClient

  constructor(database: Database, client: RecordTaskFlowClient) {
    this.database = database
    this.client = client
    this.local = sqliteTaskFlowReadStore(database)
  }

  private projectId(project: string): string {
    if (!project) throw new Error('a workflow cursor handle requires a project; pass --project')
    const row = this.database
      .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
      .get(project)
    if (!row) throw new Error(`project ${project} is not registered; register it, then retry`)
    return row.record_id
  }

  private projectName(projectId: string): string {
    const row = this.database
      .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
      .get(projectId)
    if (!row) throw new Error(`project ${projectId} is not registered; register it, then retry`)
    return row.name
  }

  private destination(project: string): RecordRequestDestination {
    const destinationSpaceId = workflowReadSpaceFor(this.database, project)
    return destinationSpaceId ? { destinationSpaceId } : {}
  }

  private async list(selector: StageListSelector, project?: string): Promise<ListedItem[]> {
    return listAllTaskFlowStages(
      this.client,
      selector,
      project ? this.destination(project) : undefined,
    )
  }

  private async byId(id: string): Promise<HostedTaskFlowStageById | null> {
    const read = this.client.readTaskFlowStage
    if (!read)
      throw new Error('record API predates task-flow stage reads; release hosted-api, then retry')
    return read(id)
  }

  private async flow(selector: {
    taskId?: string
    flowRecordId?: string
  }): Promise<HostedTaskFlow | null> {
    const read = this.client.readTaskFlow
    if (!read)
      throw new Error('record API predates task-flow reads; release hosted-api, then retry')
    try {
      return await read(selector)
    } catch (error) {
      if (
        error instanceof RecordApiRequestError &&
        error.status === 404 &&
        error.code === RECORD_TASK_FLOW_NOT_FOUND_CODE
      )
        return null
      throw error
    }
  }

  async openStageForTask(taskRecordId: string) {
    const flow = await this.flow({ taskId: taskRecordId })
    return flow?.stage ? stageRow({ stage: flow.stage, flow: flow.flow }, false) : null
  }
  async flowProjectionForTask(taskRecordId: string) {
    const result = await this.flow({ taskId: taskRecordId })
    return result
      ? { record_id: result.flow.id, open_stage_cursor_record_id: result.flow.openStageRecordId }
      : null
  }
  async stageByRecordId(recordId: string) {
    const result = await this.byId(recordId)
    return result ? stageRow(stageItem(result)) : null
  }
  async latestStageForTask(input: {
    project: string
    workflow: string
    mode: string
    taskRecordId: string
  }) {
    const rows = await this.list(
      {
        projectId: this.projectId(input.project),
        workflow: input.workflow,
        mode: input.mode,
        taskId: input.taskRecordId,
        primaryInstance: true,
        order: 'newest',
      },
      input.project,
    )
    return rows[0] ? stageRow(rows[0]) : null
  }
  async openKeylessStages(input: {
    project: string
    workflow: string
    mode: string
    sessionId: string
    untouched: boolean
  }) {
    const rows = await this.list(
      {
        projectId: this.projectId(input.project),
        workflow: input.workflow,
        mode: input.mode,
        sessionId: input.sessionId,
        keyless: true,
        states: ['running', 'awaiting-ruling'],
      },
      input.project,
    )
    return rows.map(stageRow).filter((row) => !input.untouched || row.ordinal === 0)
  }
  async activeStageModes(input: {
    project: string
    workflow: string
    taskRecordId: string | null
    key: string
    sessionId: string
  }) {
    const common = {
      projectId: this.projectId(input.project),
      workflow: input.workflow,
      states: ['running', 'awaiting-ruling'] as const,
    }
    const groups = input.key
      ? await Promise.all([
          input.taskRecordId
            ? this.list(
                { ...common, taskId: input.taskRecordId, primaryInstance: true },
                input.project,
              )
            : [],
          this.list({ ...common, workflowKey: input.key, primaryInstance: true }, input.project),
        ])
      : [await this.list({ ...common, keyless: true, sessionId: input.sessionId }, input.project)]
    return [...new Set(groups.flat().map(({ stage }) => stage.mode))]
      .sort()
      .map((modeSlug) => ({ mode_slug: modeSlug }))
  }
  listOpenStages(input: { project?: string; sessionId?: string }) {
    return this.local.listOpenStages(input)
  }
  async openStageWorktrees() {
    return (await this.list({ states: ['running', 'awaiting-ruling'] }))
      .map(stageRow)
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        number: row.id,
        workflow: row.workflow_slug,
        project: row.project,
        args: row.args,
      }))
  }
  async activeStageAutonomy(project: string, taskRecordId: string) {
    return (
      await this.list(
        {
          projectId: this.projectId(project),
          taskId: taskRecordId,
          states: ['running', 'awaiting-ruling'],
        },
        project,
      )
    )
      .map(stageRow)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)
      .map(({ autonomy }) => ({ autonomy }))
  }
  async stageIdentityMap() {
    return (await this.list({ states: ['running', 'awaiting-ruling', 'done', 'abandoned'] }))
      .map(stageRow)
      .sort((a, b) => a.id - b.id)
      .map(({ id: number, record_id }) => ({ number, record_id }))
  }
  async stageByHandle(project: string, cursor: number) {
    const rows = await this.list({ projectId: this.projectId(project), number: cursor }, project)
    return rows[0] ? stageRow(rows[0]) : null
  }
  async stageHoldingTaskKey(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }) {
    const rows = await this.list(
      {
        projectId: this.projectId(input.project),
        workflow: input.workflow,
        mode: input.mode,
        workflowKey: input.key,
        states: ['running', 'awaiting-ruling'],
      },
      input.project,
    )
    return rows[0] ? { id: required(rows[0].stage.number, 'number') } : null
  }
  waitingWorkflowQuestions() {
    return this.local.waitingWorkflowQuestions()
  }
  async flowState(recordId: string) {
    const result = await this.flow({ flowRecordId: recordId })
    return result
      ? {
          record_id: result.flow.id,
          revision: result.flow.revision,
          open_stage_cursor_record_id: result.flow.openStageRecordId,
        }
      : null
  }
  async textsForStage(stageRecordId: string) {
    const result = await this.byId(stageRecordId)
    return (result?.stage.stepTexts ?? []).map(textRow)
  }
  async textByRecordId(recordId: string) {
    const result = await this.client.readTaskFlowText?.(recordId)
    return result
      ? {
          cursor_record_id: result.text.stageRecordId,
          step_ordinal: result.text.stepOrdinal,
          step_slug: result.text.stepSlug,
          body: result.text.body,
        }
      : null
  }
  async textAttachmentByRecordId(recordId: string) {
    const result = await this.client.readTaskFlowText?.(recordId)
    return result ? textRow(result.text) : null
  }
  async textRecordIdsForStage(stageRecordId: string) {
    return (await this.textsForStage(stageRecordId)).map(({ id }) => id)
  }
  async copiedTextRecordIdsForStage(stageRecordId: string) {
    const result = await this.byId(stageRecordId)
    return (result?.stage.textCopies ?? []).map(({ workflowTextRecordId }) => workflowTextRecordId)
  }
  async stageProject(recordId: string) {
    return (await this.byId(recordId))?.stage.projectName ?? null
  }
  async uncopiedTextsForStage(stageRecordId: string) {
    const result = await this.byId(stageRecordId)
    if (!result) return []
    const copied = new Set(
      (result.stage.textCopies ?? []).map(({ workflowTextRecordId }) => workflowTextRecordId),
    )
    return (result.stage.stepTexts ?? [])
      .filter(({ id }) => !copied.has(id))
      .map((text) => ({
        record_id: text.id,
        step_slug: text.stepSlug,
        body: text.body,
        created_at: text.createdAt,
      }))
  }
  async liveTextAttachment(recordId: string) {
    const result = await this.client.readTaskFlowText?.(recordId)
    return result
      ? {
          cursor: required(result.stage.number, 'number'),
          step_slug: result.text.stepSlug,
          body: result.text.body,
        }
      : null
  }
  async copiedTextReference(recordId: string) {
    return (await this.client.readTaskFlowText?.(recordId))?.copy?.taskDocumentReference ?? null
  }
  async openObligationRecordIds(stageRecordId: string) {
    return (await this.openObligations(stageRecordId)).map(({ id }) => id)
  }
  async openObligations(stageRecordId: string) {
    const result = await this.byId(stageRecordId)
    if (!result) return []
    const number = required(result.stage.number, 'number')
    return (result.stage.obligations ?? [])
      .filter(({ satisfiedAt, abandonedAt }) => !satisfiedAt && !abandonedAt)
      .map((row) => openObligationRow(row, number))
  }
  async obligationByRecordId(recordId: string): Promise<TaskFlowObligationRow | null> {
    const result = await this.client.readTaskFlowObligation?.(recordId)
    if (!result) return null
    return {
      ...openObligationRow(result.obligation, required(result.stage.number, 'number')),
      cursor_record_id: result.obligation.stageRecordId,
      satisfied_at: result.obligation.satisfiedAt,
      abandoned_at: result.obligation.abandonedAt,
    }
  }
  async nextKeylessInstanceSlot(input: {
    projectRecordId: string
    workflow: string
    mode: string
    sessionId: string | null
    machineId: string
  }) {
    const project = this.projectName(input.projectRecordId)
    const rows = await this.list(
      {
        projectId: input.projectRecordId,
        workflow: input.workflow,
        mode: input.mode,
        keyless: true,
        ...(input.sessionId
          ? { sessionId: input.sessionId }
          : { openedMachineId: input.machineId }),
      },
      project,
    )
    return rows.length + 1
  }
  async flowForTask(taskRecordId: string) {
    const result = await this.flow({ taskId: taskRecordId })
    return result ? { record_id: result.flow.id, revision: result.flow.revision } : null
  }
  async hasStage(recordId: string) {
    return (await this.byId(recordId)) !== null
  }
  async stagesNeedingTaskLink(project: string, workflowKey: string) {
    return (
      await this.list({ projectId: this.projectId(project), workflowKey, unlinked: true }, project)
    )
      .map(({ stage }) => ({
        record_id: stage.id,
        revision: stage.revision,
        updated_at: stage.updatedAt,
      }))
      .sort((a, b) => a.record_id.localeCompare(b.record_id))
  }
  async unlinkedLabelHolder(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }) {
    const rows = await this.list(
      {
        projectId: this.projectId(input.project),
        workflow: input.workflow,
        mode: input.mode,
        workflowKey: input.key,
        primaryInstance: true,
      },
      input.project,
    )
    return rows[0]?.stage.number ?? null
  }
  closeOutShipTaskStage(sessionId: string, project: string, branch: string) {
    return this.local.closeOutShipTaskStage(sessionId, project, branch)
  }
  cursorWorkForSession(sessionId: string) {
    return this.local.cursorWorkForSession(sessionId)
  }
  cursorLifecycleForSession(sessionId: string) {
    return this.local.cursorLifecycleForSession(sessionId)
  }
  openStagesForSession(sessionId: string) {
    return this.local.openStagesForSession(sessionId)
  }
  openWorkflowQuestionCountForSession(sessionId: string) {
    return this.local.openWorkflowQuestionCountForSession(sessionId)
  }
  workflowInboxQuestions() {
    return this.local.workflowInboxQuestions()
  }
  rulingRows(input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  }) {
    return this.local.rulingRows(input)
  }
  rulingFileQuestion(questionId: string) {
    return this.local.rulingFileQuestion(questionId)
  }
  questionCloseFacts(questionId: string) {
    return this.local.questionCloseFacts(questionId)
  }
  overturnRulingRow(questionId: string) {
    return this.local.overturnRulingRow(questionId)
  }
  async pendingTaskLinks(table: 'workflow_cursor' | 'question') {
    if (table === 'question') return this.local.pendingTaskLinks(table)
    return (await this.list({ unlinked: true }))
      .filter(({ stage }) => Boolean(stage.workflowKey && stage.projectName))
      .map(({ stage }) => ({
        id: stage.id,
        task_key: stage.workflowKey!,
        project: stage.projectName!,
      }))
  }
  async linkedTaskReferences(table: 'workflow_cursor' | 'question') {
    if (table === 'question') return this.local.linkedTaskReferences(table)
    return (await this.list({ linked: true })).map(({ stage, flow }) => ({
      task_record_id: required(flow.taskId, 'task reference'),
      project: required(stage.projectName, 'project name'),
    }))
  }
  async projectReferenceCounts(projectRecordId: string) {
    const read = this.client.readTaskFlowProjectReferenceCounts
    if (!read)
      throw new Error(
        'record API predates task-flow reference counts; release hosted-api, then retry',
      )
    const result = await read(projectRecordId)
    return { workflow_cursor: result.stages, task_flow: result.flows }
  }
  taskRulingRows(project: string, taskRecordId: string, limit: number) {
    return this.local.taskRulingRows(project, taskRecordId, limit)
  }
  localQuestionProjects() {
    return this.local.localQuestionProjects()
  }
}

export function recordTaskFlowReadStore(
  database: Database,
  client: RecordTaskFlowClient = recordApiClient(),
): TaskFlowReadStore {
  return new RecordTaskFlowReadStore(database, client)
}
