// concern: hosted task-flow read adapter
/** Converts hosted task-flow reads to the workflow read-port row shapes. */

import type { Database } from 'bun:sqlite'
import { declaredRecordSpace } from '../project/declared-record-space.ts'
import { projectByName, projectByRecordId, projects } from '../project/project-read.ts'
import {
  allQuestionRulingsPaged,
  unlinkedWorkflowQuestions,
} from '../question-store/question-store-read.ts'
import { recordQuestionReads } from '../question-store/question-store-record-task-flow-compat.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type {
  RecordRequestDestination,
  RecordWriteDestination,
} from '../record/record-api-client-paths.ts'
import { isAbsentRecordKeyedRead } from '../record/record-api-client-response.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import type { RecordIdentity } from '../record/record-auth.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import {
  type HostedTaskFlow,
  type HostedTaskFlowStageById,
  type HostedTaskFlowStageList,
  isClosedStageState,
  TASK_FLOW_OPEN_STAGE_STATES,
  TASK_FLOW_STAGE_LIST_LIMIT_MAX,
  TASK_FLOW_STAGE_STATES,
} from '../record/record-task-flow-contract.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import {
  type ListedItem,
  required,
  stageItem,
  stageRow,
} from './task-flow-store-record-stage-row.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'
import type {
  TaskFlowObligationRow,
  TaskFlowOpenObligationRow,
  TaskFlowOpenStageWorktreeRow,
  TaskFlowStageCursorRow,
  TaskFlowTextRow,
} from './task-flow-store-types.ts'

type HostedStage = HostedTaskFlowStageById['stage']
type StageListSelector = Omit<
  Parameters<NonNullable<RecordTaskFlowClient['listTaskFlowStages']>>[0],
  'cursor' | 'limit'
>

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
  cursorProject: string,
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
    cursor_project: cursorProject,
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

class RecordTaskFlowReadStore {
  private readonly database: Database
  private readonly client: RecordTaskFlowClient
  private identityRead?: Promise<RecordIdentity>
  private readonly destinations = new Map<string, Promise<RecordWriteDestination>>()
  private everyDestination?: Promise<RecordWriteDestination[]>
  private readonly questions: ReturnType<typeof recordQuestionReads>

  constructor(database: Database, client: RecordTaskFlowClient) {
    this.database = database
    this.client = client
    this.questions = recordQuestionReads(database, {
      list: (selector, project) => this.list(selector, project),
      listEvery: (selector) => this.listEveryDestination(selector),
      byId: (id) => this.byId(id),
      projectId: (project) => this.projectId(project),
    })
  }

  // Resolved on the first read that needs a destination, so a store used only
  // for local reads never reaches the record.
  private identity(): Promise<RecordIdentity> {
    this.identityRead ??= this.client.whoami ? this.client.whoami() : recordApiClient().whoami()
    return this.identityRead
  }

  private projectId(project: string): string {
    if (!project) throw new Error('a workflow cursor handle requires a project; pass --project')
    const row = projectByName(project, this.database)
    if (!row) throw new Error(`project ${project} is not registered; register it, then retry`)
    return row.recordId
  }

  private projectName(projectId: string): string {
    const row = projectByRecordId(projectId, this.database)
    if (!row) throw new Error(`project ${projectId} is not registered; register it, then retry`)
    return row.name
  }

  private destination(project: string): Promise<RecordWriteDestination> {
    const cached = this.destinations.get(project)
    if (cached) return cached
    const row = projectByName(project, this.database)
    if (!row) throw new Error(`project ${project} is not registered; register it, then retry`)
    const destination = requireProjectRecordDestination(project, row.settings, {
      whoami: () => this.identity(),
    }).then((destinationSpaceId) => ({ destinationSpaceId }))
    this.destinations.set(project, destination)
    return destination
  }

  private async allDestinations(): Promise<RecordWriteDestination[]> {
    this.everyDestination ??= Promise.all(
      projects(undefined, this.database)
        .filter(({ settings }) => declaredRecordSpace(settings) !== null)
        .map(({ name }) => this.destination(name)),
    ).then((destinations) => [
      ...new Map(
        destinations.map((destination) => [destination.destinationSpaceId, destination]),
      ).values(),
    ])
    return this.everyDestination
  }

  private readText(recordId: string) {
    const read = this.client.readTaskFlowText
    if (!read)
      throw new Error('record API predates task-flow text reads; release hosted-api, then retry')
    return read(recordId)
  }

  private async list(selector: StageListSelector, project?: string): Promise<ListedItem[]> {
    return listAllTaskFlowStages(
      this.client,
      selector,
      project ? await this.destination(project) : undefined,
    )
  }

  private async listEveryDestination(selector: StageListSelector): Promise<ListedItem[]> {
    const destinations = await this.allDestinations()
    return (
      await Promise.all(
        destinations.map((destination) =>
          listAllTaskFlowStages(this.client, selector, destination),
        ),
      )
    ).flat()
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
      if (isAbsentRecordKeyedRead(error)) return null
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
        states: [...TASK_FLOW_OPEN_STAGE_STATES],
      },
      input.project,
    )
    return rows.map((row) => stageRow(row)).filter((row) => !input.untouched || row.ordinal === 0)
  }
  async activeStageModes(input: {
    project: string
    workflow: string
    taskRecordId: string | null
    key: string
    sessionId: string
  }) {
    const common: StageListSelector = {
      projectId: this.projectId(input.project),
      workflow: input.workflow,
      states: [...TASK_FLOW_OPEN_STAGE_STATES],
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
  async listOpenStages(input: { project?: string; sessionId?: string }) {
    return this.questions.listOpenStages(input)
  }
  async listStages(input: {
    project?: string
    sessionId?: string
    states: readonly [TaskFlowStageCursorRow['state'], ...TaskFlowStageCursorRow['state'][]]
  }) {
    return this.questions.listStages(input)
  }
  async keyedStageHistory(input: { since: string }) {
    return (
      await this.listEveryDestination({
        states: [...TASK_FLOW_STAGE_STATES],
      })
    )
      .map((item) => stageRow(item))
      .filter(
        (row) =>
          row.workflow_key !== '' &&
          (!isClosedStageState(row.state) || row.updated_at >= input.since),
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id)
  }
  async openStageWorktrees(): Promise<TaskFlowOpenStageWorktreeRow[]> {
    return (await this.listEveryDestination({ states: [...TASK_FLOW_OPEN_STAGE_STATES] }))
      .map((row) => stageRow(row))
      .map((row) => ({
        record_id: row.record_id,
        number: row.id,
        workflow: row.workflow_slug,
        project: row.project,
        args: row.args,
        closed: row.closed,
        revision: row.revision,
      }))
      .sort(
        (left, right) => left.project.localeCompare(right.project) || left.number - right.number,
      )
  }
  async activeStageAutonomy(project: string, taskRecordId: string) {
    return (
      await this.list(
        {
          projectId: this.projectId(project),
          taskId: taskRecordId,
          states: [...TASK_FLOW_OPEN_STAGE_STATES],
        },
        project,
      )
    )
      .map((row) => stageRow(row))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)
      .map(({ autonomy }) => ({ autonomy }))
  }
  async stageIdentityMap() {
    return this.questions.stageIdentityMap()
  }
  async stageByHandle(project: string | undefined, cursor: number) {
    const projectId = this.projectId(project ?? '')
    const rows = await this.list({ projectId, number: cursor }, project)
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
        states: [...TASK_FLOW_OPEN_STAGE_STATES],
      },
      input.project,
    )
    return rows[0] ? { id: rows[0].stage.number } : null
  }
  async waitingWorkflowQuestions() {
    return this.questions.waitingWorkflowQuestions()
  }
  async flowState(recordId: string) {
    const result = await this.flow({ flowRecordId: recordId })
    return result
      ? {
          record_id: result.flow.id,
          revision: result.flow.revision,
          open_stage_cursor_record_id: result.flow.openStageRecordId,
          parent_flow_record_id: result.flow.parentFlowRecordId ?? null,
        }
      : null
  }
  async textsForFlowLineage(flowRecordId: string, stageRecordId: string) {
    const lineage: HostedTaskFlow[] = []
    const visited = new Set<string>()
    let current = await this.flow({ flowRecordId })
    while (current && !visited.has(current.flow.id)) {
      visited.add(current.flow.id)
      lineage.push(current)
      const parent = current.flow.parentFlowRecordId
      current = parent && !visited.has(parent) ? await this.flow({ flowRecordId: parent }) : null
    }
    return lineage.reverse().flatMap((item) =>
      [item.stage, ...(item.otherStages ?? [])]
        .filter((stage): stage is NonNullable<typeof stage> => stage !== null)
        .filter((stage) => item.flow.id !== flowRecordId || stage.id === stageRecordId)
        .sort((left, right) => left.number - right.number)
        .flatMap((stage) => (stage.stepTexts ?? []).map(textRow)),
    )
  }
  async textsForStage(stageRecordId: string) {
    const result = await this.byId(stageRecordId)
    return (result?.stage.stepTexts ?? []).map(textRow)
  }
  async textByRecordId(recordId: string) {
    const result = await this.readText(recordId)
    return result?.text
      ? {
          cursor_record_id: result.text.stageRecordId,
          step_ordinal: result.text.stepOrdinal,
          step_slug: result.text.stepSlug,
          body: result.text.body,
        }
      : null
  }
  async textAttachmentByRecordId(recordId: string) {
    const result = await this.readText(recordId)
    if (!result?.text) return null
    return { ...textRow(result.text), copied_at: result.copy?.copiedAt ?? null }
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
    const result = await this.readText(recordId)
    return result?.text
      ? {
          cursor: result.stage.number,
          step_slug: result.text.stepSlug,
          body: result.text.body,
        }
      : null
  }
  async copiedTextReference(recordId: string) {
    const result = await this.readText(recordId)
    return result?.copy?.taskDocumentReference ?? null
  }
  async openObligationRecordIds(stageRecordId: string) {
    return (await this.openObligations(stageRecordId)).map(({ id }) => id)
  }
  async openObligations(stageRecordId: string) {
    const result = await this.byId(stageRecordId)
    if (!result) return []
    const number = result.stage.number
    return (result.stage.obligations ?? [])
      .filter(({ satisfiedAt, abandonedAt }) => !satisfiedAt && !abandonedAt)
      .map((row) => openObligationRow(row, number, this.projectName(result.stage.projectId)))
  }
  async obligationByRecordId(recordId: string): Promise<TaskFlowObligationRow | null> {
    const read = this.client.readTaskFlowObligation
    if (!read)
      throw new Error(
        'record API predates task-flow obligation reads; release hosted-api, then retry',
      )
    const result = await read(recordId)
    if (!result) return null
    const stage = await this.byId(result.stage.id)
    if (!stage) throw new Error(`workflow stage ${result.stage.id} does not exist`)
    const {
      stepOrdinal: _stepOrdinal,
      stepSlug: _stepSlug,
      ...row
    } = openObligationRow(
      result.obligation,
      result.stage.number,
      this.projectName(stage.stage.projectId),
    )
    return {
      ...row,
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
  async closeOutShipTaskStage(sessionId: string, project: string, branch: string) {
    return this.questions.closeOutShipTaskStage(sessionId, project, branch)
  }
  async cursorWorkForSession(sessionId: string) {
    return this.questions.cursorWorkForSession(sessionId)
  }
  async cursorLifecycleForSession(sessionId: string) {
    return this.questions.cursorLifecycleForSession(sessionId)
  }
  async openStagesForSession(sessionId: string) {
    return this.questions.openStagesForSession(sessionId)
  }
  async keylessSessionCursors(project: string | null) {
    return this.questions.keylessSessionCursors(project)
  }
  async workflowInboxQuestions() {
    return this.questions.workflowInboxQuestions()
  }
  rulingRows(input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  }) {
    return this.questions.rulingRows(input)
  }
  async rulingFileQuestion(questionId: string) {
    return this.questions.rulingFileQuestion(questionId)
  }
  async questionCloseFacts(questionId: string) {
    return this.questions.questionCloseFacts(questionId)
  }
  async overturnRulingRow(questionId: string) {
    return this.questions.overturnRulingRow(questionId)
  }
  async pendingTaskLinks(table: 'workflow_cursor' | 'question') {
    if (table === 'question')
      return (await unlinkedWorkflowQuestions(this.database)).flatMap((row) =>
        row.workflow_task_record_id == null && row.workflow_key && row.project
          ? [
              {
                id: String(row.record_id),
                task_key: String(row.workflow_key),
                project: String(row.project),
              },
            ]
          : [],
      )
    return (await this.listEveryDestination({ unlinked: true }))
      .filter(({ stage }) => Boolean(stage.workflowKey && stage.projectName))
      .map(({ stage }) => ({
        id: stage.id,
        task_key: stage.workflowKey!,
        project: stage.projectName!,
      }))
  }
  async linkedTaskReferences(table: 'workflow_cursor' | 'question') {
    if (table === 'question')
      return (await allQuestionRulingsPaged(this.database, 'workflow')).flatMap((row) =>
        row.workflow_task_record_id && row.project
          ? [
              {
                task_record_id: String(row.workflow_task_record_id),
                project: String(row.project),
              },
            ]
          : [],
      )
    return (await this.listEveryDestination({ linked: true })).map(({ stage, flow }) => ({
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
  async taskRulingRows(project: string, taskRecordId: string, limit: number) {
    return this.questions.taskRulingRows(project, taskRecordId, limit)
  }
  async localQuestionProjects() {
    return this.questions.localQuestionProjects()
  }
}

export function recordTaskFlowReadStore(
  database: Database,
  client: RecordTaskFlowClient = recordApiClient(),
): RecordTaskFlowReadStore {
  return new RecordTaskFlowReadStore(database, client)
}

export function resolveTaskFlowReadStore(
  database: Database,
  client: RecordTaskFlowClient = recordApiClient(),
) {
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  return decision.verdict === 'hosted'
    ? recordTaskFlowReadStore(database, client)
    : sqliteTaskFlowReadStore(database)
}
