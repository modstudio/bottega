// concern: record-history-upload
/** Uploads local workflow history during sign-in and each hosted-record sync pass. */

import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStateRoot } from '../../../shared/state-directory.ts'
import { DocRevisionConflictError, RECORD_DIFFERENT_CONTENT } from '../doc/doc-revision-conflict.ts'
import { BOUNDED_JSONL_ARCHIVE_KEEP, writeBoundedJsonlArchive } from '../jsonl-archive.ts'
import type { ProjectAdoptionResult } from '../project/project-relink.ts'
import {
  localQuestionHistory,
  localQuestionHistoryProjectIds,
  unattributedLocalQuestionHistory,
} from '../question-store/question-store.ts'
import { questionSnapshotFromRow } from '../question-store/question-store-mutation.ts'
import { taskFlowHistoryMaintenanceStore } from '../workflow/task-flow-store.ts'
import { storeHasAttachedToHostedRecord } from './install-binding.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import type { RecordWriteDestination } from './record-api-client-paths.ts'
import {
  readHeldFlowIds,
  readHeldQuestionIds,
  storeHeldFlowIds,
  storeHeldQuestionIds,
  WORKFLOW_HISTORY_UPLOAD_FINGERPRINT_KEY,
} from './record-history-upload-state.ts'
import {
  collectHostedRowState,
  HOSTED_ROW_TABLES,
  type HostedRowTable,
  hostedRowIdsAreEmpty,
  questionAuditIdentity,
  readHostedRowPresence,
} from './record-hosted-row-presence.ts'
import { type TaskFlowIntentInput, taskFlowRequestId } from './record-task-flow-write-contract.ts'
import { recordWriteDestination } from './record-write-destination.ts'

type Presentation = { log(value: string): void }
type HistoryProject = { name: string; recordId: string }
type FlowImport = TaskFlowIntentInput<'import'>
type FlowImportWithNumbers = { payload: FlowImport; numbers: Map<string, number> }
type LocalQuestionHistory = ReturnType<typeof localQuestionHistory>

export const HISTORY_UPLOAD_FAILURE_BOUND = 25
export type HistoryUploadFingerprint = ReadonlyArray<{
  table: string
  count: number
  maxRowid: number
}>
export type WithMaintenanceDatabase = <T>(action: (database: Database) => Promise<T>) => Promise<T>

type UploadDependencies = {
  client: Pick<RecordApiClient, 'importTaskFlow' | 'importQuestion' | 'readTaskFlowPresence'>
  destination(project: string | null): Promise<RecordWriteDestination>
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

/** Decide whether local hosted-history ids changed since the last successful upload pass. */
export function decideHistoryUploadPass(input: {
  stored: HistoryUploadFingerprint | null
  current: HistoryUploadFingerprint
}): 'skip' | 'upload' {
  // A successful hosted-row release clears the stored fingerprint before rowids can be reused.
  return input.stored && JSON.stringify(input.stored) === JSON.stringify(input.current)
    ? 'skip'
    : 'upload'
}

function historyUploadFingerprint(database: Database): HistoryUploadFingerprint {
  const result = (table: string, row: { count: number; maxRowid: number | null }) => {
    return { table, count: row.count, maxRowid: row.maxRowid ?? 0 }
  }
  const sql = {
    workflow_obligation: 'SELECT count(*) count,max(rowid) maxRowid FROM workflow_obligation',
    workflow_step_text: 'SELECT count(*) count,max(rowid) maxRowid FROM workflow_step_text',
    workflow_text_copy: 'SELECT count(*) count,max(rowid) maxRowid FROM workflow_text_copy',
    question_mutation_audit:
      'SELECT count(*) count,max(rowid) maxRowid FROM question_mutation_audit',
    question: 'SELECT count(*) count,max(rowid) maxRowid FROM question',
    workflow_cursor: 'SELECT count(*) count,max(rowid) maxRowid FROM workflow_cursor',
    task_flow: 'SELECT count(*) count,max(rowid) maxRowid FROM task_flow',
  } satisfies Record<HostedRowTable, string>
  return HOSTED_ROW_TABLES.map((table) =>
    result(
      table,
      database.query<{ count: number; maxRowid: number | null }, []>(sql[table]).get()!,
    ),
  )
}

function storedHistoryUploadFingerprint(database: Database): HistoryUploadFingerprint | null {
  const row = database
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(WORKFLOW_HISTORY_UPLOAD_FINGERPRINT_KEY)
  if (!row) return null
  try {
    return JSON.parse(row.value) as HistoryUploadFingerprint
  } catch {
    return null
  }
}

function storeHistoryUploadFingerprint(
  database: Database,
  fingerprint: HistoryUploadFingerprint,
): void {
  database
    .query(
      `INSERT INTO schema_meta(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(WORKFLOW_HISTORY_UPLOAD_FINGERPRINT_KEY, JSON.stringify(fingerprint))
}

function historyProjects(database: Database): HistoryProject[] {
  const questionProjects = localQuestionHistoryProjectIds(database)
  const questionOwners = questionProjects.length
    ? `OR project.record_id IN (${questionProjects.map(() => '?').join(',')})`
    : ''
  return database
    .query<HistoryProject, string[]>(
      `SELECT project.name,project.record_id recordId FROM project
       WHERE EXISTS (SELECT 1 FROM task_flow flow WHERE flow.project_record_id=project.record_id)
          OR EXISTS (SELECT 1 FROM workflow_cursor cursor WHERE cursor.project_record_id=project.record_id)
          ${questionOwners}
       ORDER BY project.name`,
    )
    .all(...questionProjects)
}

function refuseUnattributedQuestions(database: Database): void {
  const row = unattributedLocalQuestionHistory(database)
  if (row)
    throw new Error(
      `question q${row.number} belongs to missing project ${row.project_record_id}; repair its project owner, then sign in again`,
    )
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
): FlowImportWithNumbers {
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
    payload: {
      requestId: taskFlowRequestId('import', [flowId]),
      flow: {
        id: flowId,
        projectId,
        taskId: (flow.task_record_id as string | null) ?? null,
        parentFlowRecordId: (flow.parent_flow_record_id as string | null) ?? null,
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
    },
    numbers: new Map(stages.map((stage) => [String(stage.record_id), Number(stage.number)])),
  }
}

function flowImports(database: Database, projectId: string): FlowImportWithNumbers[] {
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

async function uploadSignInQuestion(
  history: LocalQuestionHistory[number],
  present: PresentHistory,
  pass: UploadPassState,
  client: UploadDependencies['client'] & {
    importQuestion: NonNullable<UploadDependencies['client']['importQuestion']>
  },
  destination: RecordWriteDestination,
) {
  const outcome = await attemptQuestionImport(history, present, pass, client, destination)
  if (outcome.kind === 'failed') return recordCall(() => Promise.reject(outcome.cause))
  return outcome.kind === 'imported' ? outcome.result : null
}

async function uploadSignInFlow(
  flow: FlowImportWithNumbers,
  pass: UploadPassState,
  client: FlowImportClient,
  destination: RecordWriteDestination,
) {
  const outcome = await attemptFlowImport(flow, pass, client, destination)
  if (outcome.kind === 'failed') return recordCall(() => Promise.reject(outcome.cause))
  return outcome.kind === 'imported' ? outcome.result : null
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
  present: PresentHistory,
  pass: UploadPassState,
): Promise<void> {
  const flows = flowImports(database, project.recordId)
  let stages = 0
  let uploadedFlows = 0
  for (const flow of flows) {
    const result = await uploadSignInFlow(flow, pass, client, destination)
    if (!result) continue
    uploadedFlows += 1
    stages += flow.payload.stages.length
    for (const stage of result.stages) {
      const old = flow.numbers.get(stage.id)
      if (old !== undefined && old !== stage.number)
        presentation.log(`cursor ${old} -> cursor ${stage.number}`)
    }
  }
  const questions = localQuestionHistory(database, project.recordId)
  let uploadedQuestions = 0
  for (const history of questions) {
    const result = await uploadSignInQuestion(history, present, pass, client, destination)
    if (!result) continue
    uploadedQuestions += 1
    const number = Number(history.row.number)
    if (number !== result.number) presentation.log(`q${number} -> q${result.number}`)
  }
  presentation.log(
    `${project.name}: uploaded ${uploadedFlows} task flows, ${stages} stages, ${uploadedQuestions} questions`,
  )
}

async function uploadPersonalQuestionHistory(
  history: LocalQuestionHistory,
  destination: RecordWriteDestination,
  client: UploadDependencies['client'] & {
    importQuestion: NonNullable<UploadDependencies['client']['importQuestion']>
  },
  presentation: Presentation,
  present: PresentHistory,
  pass: UploadPassState,
): Promise<void> {
  let uploadedQuestions = 0
  for (const item of history) {
    if (await uploadSignInQuestion(item, present, pass, client, destination)) uploadedQuestions += 1
  }
  presentation.log(`personal space: uploaded ${uploadedQuestions} questions`)
}

async function uploadDatabaseHistory(
  database: Database,
  adoptions: readonly ProjectAdoptionResult[],
  presentation: Presentation,
  dependencies: UploadDependencies,
): Promise<void> {
  refuseUnattributedQuestions(database)
  const projects = historyProjects(database)
  const personalQuestions = localQuestionHistory(database, null)
  if (!projects.length && !personalQuestions.length) {
    presentation.log('no local task-flow or question history to upload')
    return
  }
  const { importTaskFlow, importQuestion, readTaskFlowPresence } = dependencies.client
  if (!importTaskFlow || !importQuestion || !readTaskFlowPresence)
    throw new Error(
      'record API predates workflow history imports; release hosted-api, then sign in again',
    )
  const destinations = await historyDestinations(projects, adoptions, dependencies.destination)
  const personalDestination = personalQuestions.length
    ? await recordCall(() => dependencies.destination(null))
    : null
  const repaired = taskFlowHistoryMaintenanceStore(database).repairUnlinkedKeylessStages()
  presentation.log(`repaired ${repaired} unlinked local workflow stages`)
  const present = await recordCall(() =>
    readHostedRowPresence(collectHostedRowState(database).ids, readTaskFlowPresence),
  )
  const pass = newUploadPassState(database)
  const client = { ...dependencies.client, importTaskFlow, importQuestion, readTaskFlowPresence }
  for (const project of projects)
    await uploadProjectHistory(
      database,
      project,
      destinations.get(project.name)!,
      client,
      presentation,
      present,
      pass,
    )
  if (personalDestination)
    await uploadPersonalQuestionHistory(
      personalQuestions,
      personalDestination,
      client,
      presentation,
      present,
      pass,
    )
  const held = finishUploadPass(database, { failed: 0, lines: [], skipped: false }, pass)
  for (const line of held.lines) presentation.log(line)
  if (held.failed > 0) throw new Error(held.lines.at(-1) ?? 'question conflict archive failed')
  presentation.log(
    `run \`${PLATFORM_SLUG} machine update\` to verify and release local workflow history`,
  )
}

export async function uploadLocalWorkflowHistory(
  adoptions: readonly ProjectAdoptionResult[],
  presentation: Presentation,
  dependencies: Partial<UploadDependencies> & Pick<UploadDependencies, 'withDatabase'>,
): Promise<void> {
  const client = dependencies?.client ?? recordApiClient()
  const complete: UploadDependencies = {
    client,
    destination:
      dependencies?.destination ??
      ((project) =>
        recordWriteDestination(
          client as RecordApiClient,
          project === null ? null : { kind: 'project', name: project },
        )),
    withDatabase: dependencies.withDatabase,
  }
  await complete.withDatabase((database) =>
    uploadDatabaseHistory(database, adoptions, presentation, complete),
  )
}

export type HistorySyncResult = { failed: number; lines: string[]; skipped: boolean }

function flowIsAbsent(
  flow: FlowImport,
  present: Awaited<ReturnType<typeof readHostedRowPresence>>,
): boolean {
  return (
    !present.task_flow.has(flow.flow.id) ||
    flow.stages.some((row) => !present.workflow_cursor.has(row.id)) ||
    (flow.obligations ?? []).some((row) => !present.workflow_obligation.has(row.id)) ||
    (flow.texts ?? []).some((row) => !present.workflow_step_text.has(row.id)) ||
    (flow.copies ?? []).some((row) => !present.workflow_text_copy.has(row.id))
  )
}

type PresentHistory = Awaited<ReturnType<typeof readHostedRowPresence>>
type UploadPassState = {
  flowFailed: number
  flowStopped: boolean
  heldFlowIds: Set<string>
  heldFlows: FlowImportWithNumbers[]
  questionFailed: number
  questionStopped: boolean
  heldQuestionIds: Set<string>
  heldQuestions: LocalQuestionHistory
}
function newUploadPassState(database: Database): UploadPassState {
  return {
    flowFailed: 0,
    flowStopped: false,
    heldFlowIds: readHeldFlowIds(database),
    heldFlows: [],
    questionFailed: 0,
    questionStopped: false,
    heldQuestionIds: readHeldQuestionIds(database),
    heldQuestions: [],
  }
}
type SyncClient = RecordApiClient & {
  readTaskFlowPresence: NonNullable<RecordApiClient['readTaskFlowPresence']>
  importTaskFlow: NonNullable<RecordApiClient['importTaskFlow']>
  importQuestion: NonNullable<RecordApiClient['importQuestion']>
}
type DestinationFor = (
  client: RecordApiClient,
  owner: Parameters<typeof recordWriteDestination>[1],
) => Promise<RecordWriteDestination>

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

function questionIsAbsent(
  history: LocalQuestionHistory[number],
  present: PresentHistory,
  heldQuestionIds: ReadonlySet<string> = new Set(),
): boolean {
  if (heldQuestionIds.has(String(history.row.record_id))) return false
  return (
    !present.question.has(String(history.row.record_id)) ||
    history.audits.some(
      (audit) =>
        !present.question_mutation_audit.has(String(audit.id)) &&
        !present.questionAuditIdentities.has(
          questionAuditIdentity({
            questionId: String(history.row.record_id),
            action: String(audit.action),
            at: String(audit.at),
          }),
        ),
    )
  )
}

function recordUploadFailure(pass: UploadPassState, kind: 'flow' | 'question'): void {
  if (kind === 'flow') {
    pass.flowFailed += 1
    if (pass.flowFailed === HISTORY_UPLOAD_FAILURE_BOUND) pass.flowStopped = true
  } else {
    pass.questionFailed += 1
    if (pass.questionFailed === HISTORY_UPLOAD_FAILURE_BOUND) pass.questionStopped = true
  }
}

function allUploadKindsStopped(pass: UploadPassState): boolean {
  return pass.flowStopped && pass.questionStopped
}

type FlowImportClient = Pick<SyncClient, 'importTaskFlow'>
type FlowImportAttempt =
  | { kind: 'imported'; result: Awaited<ReturnType<FlowImportClient['importTaskFlow']>> }
  | { kind: 'held' }
  | { kind: 'failed'; cause: unknown }

async function attemptFlowImport(
  flow: FlowImportWithNumbers,
  pass: UploadPassState,
  client: FlowImportClient,
  destination: RecordWriteDestination,
): Promise<FlowImportAttempt> {
  const id = flow.payload.flow.id
  if (pass.heldFlowIds.has(id)) return { kind: 'held' }
  try {
    return { kind: 'imported', result: await client.importTaskFlow(flow.payload, destination) }
  } catch (cause) {
    if (
      cause instanceof DocRevisionConflictError &&
      cause.reason === 'already-exists' &&
      cause.message.includes(RECORD_DIFFERENT_CONTENT)
    ) {
      pass.heldFlows.push(flow)
      pass.heldFlowIds.add(id)
      return { kind: 'held' }
    }
    return { kind: 'failed', cause }
  }
}

type QuestionImportClient = Pick<SyncClient, 'importQuestion'>
type QuestionImportAttempt =
  | { kind: 'imported'; result: Awaited<ReturnType<QuestionImportClient['importQuestion']>> }
  | { kind: 'held' }
  | { kind: 'failed'; cause: unknown }

async function attemptQuestionImport(
  history: LocalQuestionHistory[number],
  present: PresentHistory,
  pass: UploadPassState,
  client: QuestionImportClient,
  destination: RecordWriteDestination,
): Promise<QuestionImportAttempt> {
  if (!questionIsAbsent(history, present, pass.heldQuestionIds)) return { kind: 'held' }
  const id = String(history.row.record_id)
  try {
    const result = await client.importQuestion(
      {
        requestId: taskFlowRequestId('import', ['question', id]),
        question: questionSnapshotFromRow(history.row),
        audits: history.audits,
      },
      destination,
    )
    return { kind: 'imported', result }
  } catch (cause) {
    if (errorMessage(cause).includes(RECORD_DIFFERENT_CONTENT)) {
      pass.heldQuestions.push(history)
      pass.heldQuestionIds.add(id)
      return { kind: 'held' }
    }
    return { kind: 'failed', cause }
  }
}

async function uploadMissingFlows(
  flows: FlowImportWithNumbers[],
  present: PresentHistory,
  client: SyncClient,
  destination: RecordWriteDestination,
  pass: UploadPassState,
): Promise<HistorySyncResult> {
  const result: HistorySyncResult = { failed: 0, lines: [], skipped: false }
  for (const flow of flows) {
    if (pass.flowStopped) break
    if (!flowIsAbsent(flow.payload, present)) continue
    const outcome = await attemptFlowImport(flow, pass, client, destination)
    if (outcome.kind === 'failed') {
      result.failed += 1
      recordUploadFailure(pass, 'flow')
      result.lines.push(
        `workflow history task flow ${flow.payload.flow.id} failed: ${errorMessage(outcome.cause)}`,
      )
    }
  }
  return result
}

async function uploadMissingQuestions(
  histories: LocalQuestionHistory,
  present: PresentHistory,
  client: SyncClient,
  destination: RecordWriteDestination,
  pass: UploadPassState,
): Promise<HistorySyncResult> {
  const result: HistorySyncResult = { failed: 0, lines: [], skipped: false }
  for (const history of histories) {
    if (pass.questionStopped) break
    const id = String(history.row.record_id)
    const outcome = await attemptQuestionImport(history, present, pass, client, destination)
    if (outcome.kind !== 'failed') continue
    result.failed += 1
    recordUploadFailure(pass, 'question')
    result.lines.push(`workflow history question ${id} failed: ${errorMessage(outcome.cause)}`)
  }
  return result
}

function combineHistoryResults(...results: HistorySyncResult[]): HistorySyncResult {
  return {
    failed: results.reduce((total, result) => total + result.failed, 0),
    lines: results.flatMap((result) => result.lines),
    skipped: results.some((result) => result.skipped),
  }
}

async function uploadProjectMissingHistory(
  database: Database,
  project: HistoryProject,
  present: PresentHistory,
  client: SyncClient,
  destinationFor: DestinationFor,
  pass: UploadPassState,
): Promise<HistorySyncResult> {
  let destination: RecordWriteDestination
  try {
    destination = await destinationFor(client, { kind: 'project', name: project.name })
  } catch (cause) {
    return {
      failed: 0,
      lines: [`workflow history upload skipped for ${project.name}: ${errorMessage(cause)}`],
      skipped: true,
    }
  }
  return combineHistoryResults(
    await uploadMissingFlows(
      flowImports(database, project.recordId),
      present,
      client,
      destination,
      pass,
    ),
    await uploadMissingQuestions(
      localQuestionHistory(database, project.recordId),
      present,
      client,
      destination,
      pass,
    ),
  )
}

async function uploadPersonalMissingHistory(
  database: Database,
  present: PresentHistory,
  client: SyncClient,
  destinationFor: DestinationFor,
  pass: UploadPassState,
): Promise<HistorySyncResult> {
  const histories = localQuestionHistory(database, null)
  if (!histories.some((history) => questionIsAbsent(history, present, pass.heldQuestionIds)))
    return { failed: 0, lines: [], skipped: false }
  try {
    const destination = await destinationFor(client, null)
    return uploadMissingQuestions(histories, present, client, destination, pass)
  } catch (cause) {
    return {
      failed: 0,
      lines: [`workflow history personal questions skipped: ${errorMessage(cause)}`],
      skipped: true,
    }
  }
}

function writeConflictArchive(
  flows: FlowImportWithNumbers[],
  histories: LocalQuestionHistory,
): string {
  const directory = join(resolveStateRoot(process.env), 'archive', 'history-upload-conflict')
  return writeBoundedJsonlArchive(
    [
      ...flows.map((flow) => ({ table: 'task_flow', row: flow.payload })),
      ...histories.map((history) => ({
        table: 'question',
        row: { ...history.row, audits: history.audits },
      })),
    ],
    { directory, keep: BOUNDED_JSONL_ARCHIVE_KEEP },
  )
}

function finishUploadPass(
  database: Database,
  result: HistorySyncResult,
  pass: UploadPassState,
): HistorySyncResult {
  if (pass.heldFlows.length > 0 || pass.heldQuestions.length > 0) {
    try {
      const path = writeConflictArchive(pass.heldFlows, pass.heldQuestions)
      storeHeldFlowIds(database, pass.heldFlowIds)
      storeHeldQuestionIds(database, pass.heldQuestionIds)
      if (pass.heldFlows.length > 0) {
        const ids = pass.heldFlows
          .slice(0, 3)
          .map((flow) => flow.payload.flow.id)
          .join(', ')
        result.lines.push(
          `${pass.heldFlows.length} task flows held by the record with different content; local copies archived to ${path}; first: ${ids}`,
        )
      }
      const ids = pass.heldQuestions
        .slice(0, 3)
        .map((history) => String(history.row.record_id))
        .join(', ')
      if (pass.heldQuestions.length > 0)
        result.lines.push(
          `${pass.heldQuestions.length} questions held by the record with different content; local copies archived to ${path}; first: ${ids}`,
        )
    } catch (cause) {
      result.failed += pass.heldFlows.length + pass.heldQuestions.length
      result.lines.push(`workflow history conflict archive failed: ${errorMessage(cause)}`)
    }
  }
  if (pass.flowStopped)
    result.lines.push(
      `workflow history flow upload stopped after ${pass.flowFailed} failures; the rest waits for the next sync`,
    )
  if (pass.questionStopped)
    result.lines.push(
      `workflow history question upload stopped after ${pass.questionFailed} failures; the rest waits for the next sync`,
    )
  return result
}

/** Upload only flow and question aggregates containing rows absent from the record. */
export async function uploadMissingWorkflowHistory(
  client: RecordApiClient,
  destinationFor: DestinationFor | undefined,
  withDatabase: WithMaintenanceDatabase,
): Promise<HistorySyncResult> {
  const resolveDestination = destinationFor ?? recordWriteDestination
  return withDatabase(async (database) => {
    if (!storeHasAttachedToHostedRecord(database)) return { failed: 0, lines: [], skipped: false }
    if (!client.readTaskFlowPresence || !client.importTaskFlow || !client.importQuestion)
      return {
        failed: 0,
        lines: ['workflow history upload skipped: record API lacks presence or import support'],
        skipped: true,
      }
    const repairLines: string[] = []
    let repairSkipped = false
    try {
      const repaired = taskFlowHistoryMaintenanceStore(database).repairUnlinkedKeylessStages()
      if (repaired > 0) repairLines.push(`repaired ${repaired} unlinked local workflow stages`)
    } catch (cause) {
      repairLines.push(`workflow history stage repair skipped: ${errorMessage(cause)}`)
      repairSkipped = true
    }
    const fingerprint = historyUploadFingerprint(database)
    if (
      decideHistoryUploadPass({
        stored: storedHistoryUploadFingerprint(database),
        current: fingerprint,
      }) === 'skip'
    )
      return { failed: 0, lines: repairLines, skipped: repairSkipped }
    const state = collectHostedRowState(database)
    if (hostedRowIdsAreEmpty(state.ids)) {
      if (!repairSkipped) storeHistoryUploadFingerprint(database, fingerprint)
      return { failed: 0, lines: repairLines, skipped: repairSkipped }
    }
    const capable = client as SyncClient
    let present: PresentHistory
    try {
      present = await readHostedRowPresence(state.ids, capable.readTaskFlowPresence)
    } catch (cause) {
      return {
        failed: 0,
        lines: [
          ...repairLines,
          `workflow history upload skipped: presence read failed: ${errorMessage(cause)}`,
        ],
        skipped: true,
      }
    }
    const projects: HistorySyncResult[] = []
    const pass = newUploadPassState(database)
    for (const project of historyProjects(database)) {
      if (allUploadKindsStopped(pass)) break
      projects.push(
        await uploadProjectMissingHistory(
          database,
          project,
          present,
          capable,
          resolveDestination,
          pass,
        ),
      )
    }
    const personal = pass.questionStopped
      ? { failed: 0, lines: [], skipped: false }
      : await uploadPersonalMissingHistory(database, present, capable, resolveDestination, pass)
    const result = finishUploadPass(
      database,
      combineHistoryResults(
        { failed: 0, lines: repairLines, skipped: repairSkipped },
        ...projects,
        personal,
      ),
      pass,
    )
    if (result.failed === 0 && !result.skipped) storeHistoryUploadFingerprint(database, fingerprint)
    return result
  })
}
