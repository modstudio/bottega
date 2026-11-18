// concern: record-sign-in-history-upload
/** Repairs and uploads local workflow history during the one-time hosted sign-in transition. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { withDatabaseForMigrationStep, writeTransaction } from '../database/db.ts'
import type { ProjectAdoptionResult } from '../project/project-relink.ts'
import { questionSnapshotFromRow } from '../question-store/question-store-mutation.ts'
import {
  localQuestionHistory,
  localQuestionHistoryProjectIds,
} from '../question-store/question-store-read.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import type { RecordWriteDestination } from './record-api-client-paths.ts'
import { type TaskFlowIntentInput, taskFlowRequestId } from './record-task-flow-write-contract.ts'
import { recordWriteDestination } from './record-write-destination.ts'

type Presentation = { log(value: string): void }
type HistoryProject = { name: string; recordId: string }
type FlowImport = TaskFlowIntentInput<'import'>

type UploadDependencies = {
  client: Pick<RecordApiClient, 'importTaskFlow' | 'importQuestion'>
  destination(project: string): Promise<RecordWriteDestination>
  withDatabase<T>(action: (database: Database) => Promise<T>): Promise<T>
}

const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  return JSON.parse(value)
}

const nullableJson = (value: unknown): unknown => (value == null ? null : json(value))
const requiredString = (value: unknown, label: string): string => {
  if (typeof value === 'string' && value.length > 0) return value
  throw new Error(`${label} is missing; run \`${PLATFORM_SLUG} machine doctor\`, then retry`)
}

function historyProjects(database: Database): HistoryProject[] {
  const projectIds = localQuestionHistoryProjectIds(database)
  const rows = database
    .query<HistoryProject, []>(
      `SELECT project.name,project.record_id recordId FROM project
       WHERE EXISTS (SELECT 1 FROM task_flow flow WHERE flow.project_record_id=project.record_id)
          OR EXISTS (SELECT 1 FROM workflow_cursor cursor WHERE cursor.project_record_id=project.record_id)
       ORDER BY project.name`,
    )
    .all()
  const known = new Set(rows.map((row) => row.recordId))
  if (!projectIds.some((id) => !known.has(id))) return rows
  const questionProjects = new Set(projectIds)
  return database
    .query<HistoryProject, []>('SELECT name,record_id recordId FROM project ORDER BY name')
    .all()
    .filter((row) => known.has(row.recordId) || questionProjects.has(row.recordId))
}

function unmatchedAdoption(
  project: string,
  adoptions: readonly ProjectAdoptionResult[],
): ProjectAdoptionResult | undefined {
  const adoption = adoptions.find((candidate) => candidate.name === project)
  if (!adoption || ['no-namesake', 'retired-namesake', 'failed'].includes(adoption.status))
    return adoption
  return undefined
}

function projectMismatchRefusal(project: string, spaceId: string): string {
  return (
    `local project ${project} has workflow history but did not relink in hosted space ${spaceId}; ` +
    `run \`${PLATFORM_SLUG} project relink ${project}\`, then sign in again`
  )
}

type UnlinkedCursor = {
  record_id: string
  number: number
  project: string
  project_record_id: string
  task_record_id: string | null
  state: 'running' | 'awaiting-ruling' | 'done' | 'abandoned'
  created_at: string
  updated_at: string
  opened_machine_id: string | null
  last_advanced_machine_id: string | null
}

function repairUnlinkedKeylessStages(database: Database): number {
  const rows = database
    .query<UnlinkedCursor, []>(
      `SELECT record_id,number,project,project_record_id,task_record_id,state,created_at,updated_at,
              opened_machine_id,last_advanced_machine_id
       FROM workflow_cursor WHERE task_flow_record_id IS NULL ORDER BY project_record_id,number`,
    )
    .all()
  const keyed = rows.find((row) => row.task_record_id !== null)
  if (keyed)
    throw new Error(
      `cursor ${keyed.number} in project ${keyed.project} has a task but no task flow; ask the architect to repair that task-flow link, then sign in again`,
    )
  return writeTransaction(() => {
    let repaired = 0
    for (const row of rows) {
      const flowId = newRecordId()
      const open = row.state === 'running' || row.state === 'awaiting-ruling'
      database
        .query(
          `INSERT INTO task_flow
            (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,
             created_at,updated_at,opening_machine_id,updated_machine_id,revision)
           VALUES (?,NULL,?,?,?,?,?,?,?,1)`,
        )
        .run(
          flowId,
          row.project_record_id,
          open ? 'open' : row.state === 'done' ? 'done' : 'dropped',
          open ? row.record_id : null,
          row.created_at,
          row.updated_at,
          requiredString(row.opened_machine_id, `cursor ${row.number} opening machine`),
          requiredString(row.last_advanced_machine_id, `cursor ${row.number} updated machine`),
        )
      database
        .query(
          'UPDATE workflow_cursor SET task_flow_record_id=? WHERE record_id=? AND task_flow_record_id IS NULL',
        )
        .run(flowId, row.record_id)
      repaired++
    }
    return repaired
  }, database)
}

function stageImport(stage: Record<string, unknown>, flowId: string, projectId: string) {
  return {
    id: String(stage.record_id),
    flowRecordId: flowId,
    projectId,
    workflow: String(stage.workflow_slug),
    mode: String(stage.mode_slug),
    workflowKey: String(stage.workflow_key),
    instanceId: String(stage.instance_id),
    sessionId: ((stage.session_id as string | null) ??
      null) as FlowImport['stages'][number]['sessionId'],
    workflowVersionId: String(stage.workflow_version_record_id),
    catalogueVersionId: String(stage.catalogue_version_record_id),
    arguments: json(stage.args) as Record<string, string>,
    activeOrdinal: Number(stage.ordinal),
    activeSlug: String(stage.step_slug),
    state: stage.state as FlowImport['stages'][number]['state'],
    closedStepNotes: json(stage.closed) as unknown[],
    question: (stage.question as string | null) ?? null,
    autonomy: (stage.autonomy as string | null) ?? null,
    enforcement: String(stage.enforcement),
    totalSteps: Number(stage.total_steps),
    openedMachineId: requiredString(
      stage.opened_machine_id,
      `cursor ${stage.number} opening machine`,
    ),
    takenOverFromMachineId: (stage.taken_over_from_machine_id as string | null) ?? null,
    lastAdvancedMachineId: requiredString(
      stage.last_advanced_machine_id,
      `cursor ${stage.number} updated machine`,
    ),
    revision: Number(stage.revision),
    createdAt: String(stage.created_at),
    updatedAt: String(stage.updated_at),
    ...((stage.handed_off_from_record_id as string | null)
      ? { handedOffFromRecordId: String(stage.handed_off_from_record_id) }
      : {}),
  }
}

function flowImport(
  database: Database,
  projectId: string,
  flow: Record<string, unknown>,
): FlowImport {
  const flowId = String(flow.record_id)
  const stages = database
    .query<Record<string, unknown>, [string]>(
      'SELECT * FROM workflow_cursor WHERE task_flow_record_id=? ORDER BY number',
    )
    .all(flowId)
  const obligations = database
    .query<Record<string, unknown>, [string]>(
      `SELECT child.* FROM workflow_obligation child JOIN workflow_cursor cursor ON cursor.record_id=child.cursor_record_id
     WHERE cursor.task_flow_record_id=? ORDER BY cursor.number,child.rowid`,
    )
    .all(flowId)
  const texts = database
    .query<Record<string, unknown>, [string]>(
      `SELECT child.* FROM workflow_step_text child JOIN workflow_cursor cursor ON cursor.record_id=child.cursor_record_id
     WHERE cursor.task_flow_record_id=? ORDER BY cursor.number,child.rowid`,
    )
    .all(flowId)
  const copies = database
    .query<Record<string, unknown>, [string]>(
      `SELECT child.* FROM workflow_text_copy child JOIN workflow_cursor cursor ON cursor.record_id=child.cursor_record_id
     WHERE cursor.task_flow_record_id=? ORDER BY cursor.number,child.rowid`,
    )
    .all(flowId)
  return {
    requestId: taskFlowRequestId('import', [flowId]),
    flow: {
      id: flowId,
      projectId,
      taskId: (flow.task_record_id as string | null) ?? null,
      state: flow.state as 'open' | 'done' | 'dropped',
      openStageRecordId: (flow.open_stage_cursor_record_id as string | null) ?? null,
      openingMachineId: requiredString(
        flow.opening_machine_id,
        `task flow ${flowId} opening machine`,
      ),
      updatedMachineId: requiredString(
        flow.updated_machine_id,
        `task flow ${flowId} updated machine`,
      ),
      revision: Number(flow.revision),
      createdAt: String(flow.created_at),
      updatedAt: String(flow.updated_at),
    },
    stages: stages.map((stage) => stageImport(stage, flowId, projectId)),
    obligations: obligations.map((row) => ({
      id: String(row.record_id),
      stageRecordId: String(row.cursor_record_id),
      stepOrdinal: Number(row.step_ordinal),
      stepSlug: String(row.step_slug),
      floor: String(row.floor),
      requirePullRequest: Boolean(row.require_pull_request),
      expectedExitCode: Number(row.expected_exit_code),
      expectedStatus: String(row.expected_status),
      floorDeferrable: Boolean(row.floor_deferrable),
      reason: String(row.reason),
      sessionId: (row.session_id as string | null) ?? null,
      createdAt: String(row.created_at),
      satisfiedAt: (row.satisfied_at as string | null) ?? null,
      satisfiedStepOrdinal:
        row.satisfied_step_ordinal == null ? null : Number(row.satisfied_step_ordinal),
      satisfiedStepSlug: (row.satisfied_step_slug as string | null) ?? null,
      satisfiedEvidence: nullableJson(row.satisfied_evidence) as unknown[] | null,
      abandonedAt: (row.abandoned_at as string | null) ?? null,
      abandonedReason: (row.abandoned_reason as string | null) ?? null,
      operatorRuling: Boolean(row.operator_ruling),
    })),
    texts: texts.map((row) => ({
      id: String(row.record_id),
      stageRecordId: String(row.cursor_record_id),
      stepOrdinal: Number(row.step_ordinal),
      stepSlug: String(row.step_slug),
      body: String(row.body),
      createdAt: String(row.created_at),
    })),
    copies: copies.map((row) => ({
      id: String(row.record_id),
      workflowTextRecordId: String(row.workflow_text_record_id),
      stageRecordId: String(row.cursor_record_id),
      taskDocumentReference: String(row.task_document_reference),
      copiedAt: String(row.copied_at),
    })),
  }
}

function flowImports(database: Database, projectId: string): FlowImport[] {
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT flow.* FROM task_flow flow WHERE flow.project_record_id=?
     ORDER BY COALESCE((SELECT MIN(number) FROM workflow_cursor WHERE task_flow_record_id=flow.record_id),9223372036854775807),flow.record_id`,
    )
    .all(projectId)
    .map((flow) => flowImport(database, projectId, flow))
}

async function recordCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; sign in again to retry`, { cause: error })
  }
}

async function historyDestinations(
  projects: HistoryProject[],
  adoptions: readonly ProjectAdoptionResult[],
  destinationFor: UploadDependencies['destination'],
): Promise<Map<string, RecordWriteDestination>> {
  const destinations = new Map<string, RecordWriteDestination>()
  for (const project of projects) {
    const destination = await recordCall(() => destinationFor(project.name))
    if (unmatchedAdoption(project.name, adoptions))
      throw new Error(projectMismatchRefusal(project.name, destination.destinationSpaceId))
    destinations.set(project.name, destination)
  }
  return destinations
}

async function uploadProjectHistory(
  database: Database,
  project: HistoryProject,
  destination: RecordWriteDestination,
  client: UploadDependencies['client'] & {
    importTaskFlow: NonNullable<UploadDependencies['client']['importTaskFlow']>
    importQuestion: NonNullable<UploadDependencies['client']['importQuestion']>
  },
  presentation: Presentation,
): Promise<void> {
  const flows = flowImports(database, project.recordId)
  let stages = 0
  for (const flow of flows) {
    const result = await recordCall(() => client.importTaskFlow(flow, destination))
    stages += flow.stages.length
    const oldNumbers = new Map(
      database
        .query<{ record_id: string; number: number }, [string]>(
          'SELECT record_id,number FROM workflow_cursor WHERE task_flow_record_id=? ORDER BY number',
        )
        .all(flow.flow.id)
        .map((row) => [row.record_id, row.number]),
    )
    for (const stage of result.stages) {
      const old = oldNumbers.get(stage.id)
      if (old !== undefined && old !== stage.number)
        presentation.log(`cursor ${old} -> cursor ${stage.number}`)
    }
  }
  const questions = localQuestionHistory(database, project.recordId).map(({ row, audits }) => ({
    requestId: newRecordId(),
    question: questionSnapshotFromRow(row),
    audits,
  }))
  for (const question of questions) {
    const result = await recordCall(() => client.importQuestion(question, destination))
    if (question.question.number !== result.number)
      presentation.log(`q${question.question.number} -> q${result.number}`)
  }
  presentation.log(
    `${project.name}: uploaded ${flows.length} task flows, ${stages} stages, ${questions.length} questions`,
  )
}

async function uploadDatabaseHistory(
  database: Database,
  adoptions: readonly ProjectAdoptionResult[],
  presentation: Presentation,
  dependencies: UploadDependencies,
): Promise<void> {
  const projects = historyProjects(database)
  if (!projects.length) {
    presentation.log('no local task-flow or question history to upload')
    presentation.log(
      `run \`${PLATFORM_SLUG} machine update\` to verify and release local workflow history`,
    )
    return
  }
  const destinations = await historyDestinations(projects, adoptions, dependencies.destination)
  const repaired = repairUnlinkedKeylessStages(database)
  presentation.log(`repaired ${repaired} unlinked local workflow stages`)
  const { importTaskFlow, importQuestion } = dependencies.client
  if (!importTaskFlow || !importQuestion)
    throw new Error(
      'record API predates workflow history imports; release hosted-api, then sign in again',
    )
  const client = { ...dependencies.client, importTaskFlow, importQuestion }
  for (const project of projects)
    await uploadProjectHistory(
      database,
      project,
      destinations.get(project.name)!,
      client,
      presentation,
    )
  presentation.log(
    `run \`${PLATFORM_SLUG} machine update\` to verify and release local workflow history`,
  )
}

export async function uploadLocalWorkflowHistory(
  adoptions: readonly ProjectAdoptionResult[],
  presentation: Presentation,
  dependencies?: Partial<UploadDependencies>,
): Promise<void> {
  const client = dependencies?.client ?? recordApiClient()
  const complete: UploadDependencies = {
    client,
    destination:
      dependencies?.destination ??
      ((project) =>
        recordWriteDestination(client as RecordApiClient, { kind: 'project', name: project })),
    withDatabase: dependencies?.withDatabase ?? withDatabaseForMigrationStep,
  }
  await complete.withDatabase((database) =>
    uploadDatabaseHistory(database, adoptions, presentation, complete),
  )
}
