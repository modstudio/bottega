// concern: record-sign-in-history-upload
/** Repairs and uploads local workflow history during the one-time hosted sign-in transition. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { withDatabaseForMigrationStep, writeTransaction } from '../database/db.ts'
import type { ProjectAdoptionResult } from '../project/project-relink.ts'
import { questionSnapshotFromRow } from '../question-store/question-store-mutation.ts'
import { storedCursorOwner } from '../workflow/workflow-cursor-transition.ts'
import { recordApiClient, type RecordApiClient } from './record-api-client.ts'
import type { RecordWriteDestination } from './record-api-client-paths.ts'
import type { QuestionImportBody } from './record-question-contract.ts'
import { recordWriteDestination } from './record-write-destination.ts'
import {
  type TaskFlowIntentInput,
  taskFlowRequestId,
} from './record-task-flow-write-contract.ts'

type Presentation = { log(value: string): void }
type HistoryProject = { name: string; recordId: string }
type FlowImport = TaskFlowIntentInput<'import'>

type UploadDependencies = {
  client: Pick<RecordApiClient, 'whoami' | 'importTaskFlow' | 'importQuestion'>
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
  return database
    .query<HistoryProject, []>(
      `SELECT project.name,project.record_id recordId FROM project
       WHERE EXISTS (SELECT 1 FROM task_flow flow WHERE flow.project_record_id=project.record_id)
          OR EXISTS (SELECT 1 FROM workflow_cursor cursor WHERE cursor.project_record_id=project.record_id)
          OR EXISTS (
            SELECT 1 FROM question q
            LEFT JOIN run owner ON owner.record_id=q.run_record_id
            LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
            WHERE COALESCE(owner.project_record_id,cursor.project_record_id)=project.record_id
          )
       ORDER BY project.name`,
    )
    .all()
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
           VALUES (?,NULL,?,?,?,?,?,?,?,?,1)`,
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
        .query('UPDATE workflow_cursor SET task_flow_record_id=? WHERE record_id=? AND task_flow_record_id IS NULL')
        .run(flowId, row.record_id)
      repaired++
    }
    return repaired
  }, database)
}

function flowImports(database: Database, projectId: string): FlowImport[] {
  const flows = database
    .query<Record<string, unknown>, [string]>(
      `SELECT flow.* FROM task_flow flow
       WHERE flow.project_record_id=?
       ORDER BY COALESCE((SELECT MIN(number) FROM workflow_cursor WHERE task_flow_record_id=flow.record_id),9223372036854775807),flow.record_id`,
    )
    .all(projectId)
  return flows.map((flow) => {
    const flowId = String(flow.record_id)
    const stages = database
      .query<Record<string, unknown>, [string]>(
        'SELECT * FROM workflow_cursor WHERE task_flow_record_id=? ORDER BY number',
      )
      .all(flowId)
    const stageIds = stages.map((stage) => String(stage.record_id))
    const childRows = <T extends Record<string, unknown>>(table: string): T[] => {
      if (!stageIds.length) return []
      return database
        .query<T, string[]>(
          `SELECT child.* FROM ${table} child JOIN workflow_cursor cursor ON cursor.record_id=child.cursor_record_id
           WHERE cursor.task_flow_record_id=? ORDER BY cursor.number,child.rowid`,
        )
        .all(flowId)
    }
    const obligations = childRows<Record<string, unknown>>('workflow_obligation')
    const texts = childRows<Record<string, unknown>>('workflow_step_text')
    const copies = childRows<Record<string, unknown>>('workflow_text_copy')
    return {
      requestId: taskFlowRequestId('import', [flowId]),
      flow: {
        id: flowId,
        projectId,
        taskId: (flow.task_record_id as string | null) ?? null,
        state: flow.state as 'open' | 'done' | 'dropped',
        openStageRecordId: (flow.open_stage_cursor_record_id as string | null) ?? null,
        openingMachineId: requiredString(flow.opening_machine_id, `task flow ${flowId} opening machine`),
        updatedMachineId: requiredString(flow.updated_machine_id, `task flow ${flowId} updated machine`),
        revision: Number(flow.revision),
        createdAt: String(flow.created_at),
        updatedAt: String(flow.updated_at),
      },
      stages: stages.map((stage) => ({
        id: String(stage.record_id),
        flowRecordId: flowId,
        projectId,
        workflow: String(stage.workflow_slug),
        mode: String(stage.mode_slug),
        workflowKey: String(stage.workflow_key),
        instanceId: String(stage.instance_id),
        sessionId: storedCursorOwner((stage.session_id as string | null) ?? null),
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
        openedMachineId: requiredString(stage.opened_machine_id, `cursor ${stage.number} opening machine`),
        takenOverFromMachineId: (stage.taken_over_from_machine_id as string | null) ?? null,
        lastAdvancedMachineId: requiredString(stage.last_advanced_machine_id, `cursor ${stage.number} updated machine`),
        revision: Number(stage.revision),
        createdAt: String(stage.created_at),
        updatedAt: String(stage.updated_at),
        ...((stage.handed_off_from_record_id as string | null)
          ? { handedOffFromRecordId: String(stage.handed_off_from_record_id) }
          : {}),
      })),
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
  })
}

function questionImports(database: Database, projectId: string): QuestionImportBody[] {
  const rows = database
    .query<Record<string, unknown>, [string]>(
      `SELECT q.*,COALESCE(owner.project_record_id,cursor.project_record_id) project_record_id
       FROM question q
       LEFT JOIN run owner ON owner.record_id=q.run_record_id
       LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
       WHERE COALESCE(owner.project_record_id,cursor.project_record_id)=?
       ORDER BY q.number`,
    )
    .all(projectId)
  return rows.map((row) => ({
    requestId: newRecordId(),
    question: questionSnapshotFromRow(row),
    audits: database
      .query<Record<string, unknown>, [string]>(
        `SELECT record_id id,action,actor_session actorSession,at,reason
         FROM question_mutation_audit WHERE question_record_id=? ORDER BY at,record_id`,
      )
      .all(String(row.record_id))
      .map((audit) => ({
        id: String(audit.id),
        action: String(audit.action),
        actorSession: (audit.actorSession as string | null) ?? null,
        at: String(audit.at),
        reason: (audit.reason as string | null) ?? null,
      })),
  }))
}

async function recordCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; sign in again to retry`, { cause: error })
  }
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
      ((project) => recordWriteDestination(client as RecordApiClient, { kind: 'project', name: project })),
    withDatabase: dependencies?.withDatabase ?? withDatabaseForMigrationStep,
  }
  await complete.withDatabase(async (database) => {
    const projects = historyProjects(database)
    if (!projects.length) {
      presentation.log('no local task-flow or question history to upload')
      presentation.log(`run \`${PLATFORM_SLUG} machine update\` to verify and release local workflow history`)
      return
    }
    const destinations = new Map<string, RecordWriteDestination>()
    for (const project of projects) {
      const destination = await recordCall(() => complete.destination(project.name))
      destinations.set(project.name, destination)
      if (unmatchedAdoption(project.name, adoptions))
        throw new Error(projectMismatchRefusal(project.name, destination.destinationSpaceId))
    }
    const repaired = repairUnlinkedKeylessStages(database)
    presentation.log(`repaired ${repaired} unlinked local workflow stages`)
    if (!complete.client.importTaskFlow || !complete.client.importQuestion)
      throw new Error('record API predates workflow history imports; release hosted-api, then sign in again')
    for (const project of projects) {
      const destination = destinations.get(project.name)!
      const flows = flowImports(database, project.recordId)
      let stages = 0
      for (const flow of flows) {
        const result = await recordCall(() => complete.client.importTaskFlow!(flow, destination))
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
      const questions = questionImports(database, project.recordId)
      for (const question of questions) {
        const result = await recordCall(() => complete.client.importQuestion!(question, destination))
        if (question.question.number !== result.number)
          presentation.log(`q${question.question.number} -> q${result.number}`)
      }
      presentation.log(
        `${project.name}: uploaded ${flows.length} task flows, ${stages} stages, ${questions.length} questions`,
      )
    }
    presentation.log(`run \`${PLATFORM_SLUG} machine update\` to verify and release local workflow history`)
  })
}
