// concern: run-outbox
/** Knows how a terminal local run becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { hasRecordIdShape, newRecordId } from '../../../shared/record-id.ts'
import { writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { isReleasedOutboxPayload } from '../record/outbox-prune-payload.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import { chainTerminationAtForRoot } from './run-chain.ts'
import { RECORD_REACHABLE_RUN_STATUS_SET, RECORD_REACHABLE_RUN_STATUS_SQL } from './run-status.ts'
import { isSyntheticLifecycleJob } from './synthetic-lifecycle-job.ts'

type LocalRun = Record<string, unknown> & {
  number: number
  record_id: string
  project_name: string | null
  project_record_id: string | null
  started_at: string
  retry_record_id: string | null
  parent_record_id: string | null
}

export type RunRecordBackfillResult = {
  enqueued: number
  refreshedLinks: number
  refreshedNumbers: number
  refreshedRoots: number
  skippedReleased: number
  skippedLive: number
}

export type RunRecordBackfillDecision =
  | 'enqueue'
  | 'refresh-number'
  | 'refresh-links'
  | 'refresh-root'
  | 'none'

export type RunRecordBackfillFacts = {
  job: string
  number: number
  status: string
  failureKind: string | null
  parentRunRecordId: string | null
  projectRecordId: string | null
  taskRecordId: string | null
  latestPayload:
    | { state: 'absent' }
    | { state: 'released' }
    | { state: 'parsed'; value: Record<string, unknown> }
}

/** A run is record-reachable once it has a publishable status and is not lifecycle bookkeeping. */
export function isRunRecordEligible(status: string, job: string): boolean {
  return RECORD_REACHABLE_RUN_STATUS_SET.has(status) && !isSyntheticLifecycleJob(job)
}

/** Roots are stamped when their whole chain ends; turns use their own finished time. */
export function runRecordFinishedAt(
  database: Database,
  runId: string,
  parentRunRecordId: string | null,
  ownFinishedAt: string,
): string {
  return parentRunRecordId === null
    ? (chainTerminationAtForRoot(database, runId) ?? ownFinishedAt)
    : ownFinishedAt
}

/** Decides whether the hosted record lacks a terminal run fact held locally. */
export function runRecordBackfillDecision(
  facts: RunRecordBackfillFacts,
): RunRecordBackfillDecision {
  if (isSyntheticLifecycleJob(facts.job)) return 'none'
  if (facts.latestPayload.state === 'absent') return 'enqueue'
  if (facts.latestPayload.state === 'released') return 'none'
  const latest = facts.latestPayload.value
  if (latest.number !== facts.number) return 'refresh-number'
  if (shouldRefreshRunRecordLinks(latest, facts.projectRecordId, facts.taskRecordId))
    return 'refresh-links'
  if (
    facts.parentRunRecordId === null &&
    (latest.status !== facts.status || latest.failureKind !== facts.failureKind)
  )
    return 'refresh-root'
  return 'none'
}

export type RunRecordBackfillInspection = Record<RunRecordBackfillDecision, number> & {
  released: number
  live: number
}

export function shouldRefreshRunRecordLinks(
  latestPayload: Record<string, unknown>,
  localProjectId: string | null,
  localTaskId: string | null,
): boolean {
  return (
    (localProjectId !== null && latestPayload.projectId == null) ||
    (localTaskId !== null && latestPayload.taskId == null)
  )
}

function json(value: unknown): unknown {
  return value == null ? null : JSON.parse(String(value))
}

function docRevisions(value: unknown): string[] | null {
  const parsed = json(value)
  if (parsed === null) return null
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string' && hasRecordIdShape(item))
  )
    throw new Error('run.doc_revisions must be a UUID array')
  return parsed
}

function resourceValues(row: LocalRun) {
  return {
    resourceCpuMs: row.resource_cpu_ms,
    resourcePeakRssBytes: row.resource_peak_rss_bytes,
    resourceSamples: row.resource_samples,
    resourceSource: row.resource_source,
  }
}

function usageValues(row: LocalRun) {
  return {
    vendorTokens: row.vendor_tokens,
    modelCalls: row.model_calls,
    peakCallTokens: row.peak_call_tokens,
    contextSystemChars: row.context_system_chars,
    contextToolCount: row.context_tool_count,
    contextToolSchemaChars: row.context_tool_schema_chars,
    contextCompactions: row.context_compactions,
    contextCacheReadTokens: row.context_cache_read_tokens,
    quotaUsedPercentStart: row.quota_used_percent_start,
    quotaUsedPercentEnd: row.quota_used_percent_end,
    quotaWindowMinutes: row.quota_window_minutes,
    quotaResetsAt: row.quota_resets_at,
    vendorCostUsd: row.vendor_cost_usd,
    vendorInputTokens: row.vendor_input_tokens,
    vendorOutputTokens: row.vendor_output_tokens,
    vendorEstimatedCostUsd: row.vendor_estimated_cost_usd,
    vendorCostSource: row.vendor_cost_source,
  }
}

function reviewValues(row: LocalRun) {
  return { reviewRef: row.review_ref, reviewRole: row.review_role }
}

function taskValues(row: LocalRun) {
  return { taskKey: row.launch_key, taskId: row.task_record_id }
}

const nullableBoolean = (value: unknown): boolean | null => (value == null ? null : Boolean(value))

/** Terminal payloads use last_event_at as finished_at when present, otherwise started_at. */
export function buildRunRecordPayload(
  row: LocalRun,
  machineId: string,
  finishedAt: string,
  evidenceUnvoid: { note: string } | null = null,
): Record<string, unknown> {
  return {
    id: row.record_id,
    number: row.number,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId,
    localId: row.number,
    startedByUserId: row.started_by_user_id,
    startedAt: row.started_at,
    finishedAt,
    agent: row.agent,
    job: row.job,
    promptSha: row.prompt_sha,
    specSha: row.spec_sha,
    promptBytes: row.prompt_bytes,
    promptHead: row.prompt_head,
    ...taskValues(row),
    label: row.label,
    lens: row.lens,
    latencyMs: row.latency_ms,
    exitCode: row.exit_code,
    outputBytes: row.output_bytes,
    ...usageValues(row),
    ...resourceValues(row),
    probe: Boolean(row.probe),
    failureKind: row.failure_kind,
    status: row.status,
    error: row.error,
    retryOf: row.retry_record_id,
    parentRunId: row.parent_record_id,
    turn: row.turn,
    filesChanged: row.files_changed,
    changedPaths: json(row.changed_paths),
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    testsRan: row.tests_ran,
    testsPassed: row.tests_passed,
    testsClaimDisagrees: nullableBoolean(row.tests_claim_disagrees),
    deviations: row.deviations,
    escalations: row.escalations,
    stack: row.stack,
    model: row.model,
    executor: row.executor,
    evidenceExcluded: row.evidence_excluded,
    evidenceUnvoid,
    inputTree: row.input_tree,
    headCommit: row.head_commit,
    ...reviewValues(row),
    branch: row.branch,
    baseCommit: row.base_commit,
    mintedBranch: row.minted_branch,
    docsInjected: row.docs_injected,
    docRevisions: docRevisions(row.doc_revisions),
    canonSha: row.canon_sha,
    transport: row.transport,
    sessionId: row.session_id,
    routeReason: row.route_reason,
    noFailover: Boolean(row.no_failover),
    automaticFailover: Boolean(row.automatic_failover),
    outsideWorktreeWrites: json(row.outside_worktree_writes),
    reviewProvenance: json(row.review_provenance),
    provenanceStatus: row.provenance_status,
    workPreserved: Boolean(row.work_preserved),
    closeOutOutcome: row.close_out_outcome,
    closeOutDetail: row.close_out_detail,
    provisioningKind: row.provisioning_kind,
    provisioningMs: row.provisioning_ms,
    provisioningPhases: json(row.provisioning_phases),
    provisioningEntries: row.provisioning_entries,
    provisioningEntriesLimited:
      row.provisioning_entries_limited == null ? null : Boolean(row.provisioning_entries_limited),
    provisioningHostLoad: json(row.provisioning_host_load),
    hostAdmissionFirst: json(row.host_admission_first),
    hostAdmission: json(row.host_admission),
    provisioningOutcome: row.provisioning_outcome,
    provisioningEntryRoots: json(row.provisioning_entry_roots),
    createdAt: row.started_at,
    updatedAt: finishedAt,
  }
}

export function enqueueRunRecord(
  database: Database,
  runId: string,
  machineId: string,
  finishedAt: string,
  evidenceUnvoid: { note: string } | null = null,
): void {
  const row = database
    .query<LocalRun, [string]>(
      `SELECT r.*, project.name AS project_name, project.record_id AS project_record_id,
              retry.record_id AS retry_record_id, parent.record_id AS parent_record_id
         FROM run r
         LEFT JOIN project ON project.record_id=r.project_record_id
         LEFT JOIN run retry ON retry.record_id=r.retry_of_record_id
         LEFT JOIN run parent ON parent.record_id=r.parent_run_record_id
        WHERE r.record_id=?`,
    )
    .get(runId)
  if (!row) throw new Error(`run ${runId} does not exist and cannot be enqueued`)
  const payload = stringifyOutboxPayload(
    'run',
    buildRunRecordPayload(
      { ...row, record_id: row.record_id },
      machineId,
      finishedAt,
      evidenceUnvoid,
    ),
  )
  insertOutboxRow(database, {
    recordId: newRecordId(),
    kind: 'run',
    rowId: row.record_id,
    payload,
    createdAt: finishedAt,
  })
}

function readableLatestPayload(payload: string | null): RunRecordBackfillFacts['latestPayload'] {
  if (payload === null) return { state: 'absent' }
  if (isReleasedOutboxPayload(payload)) return { state: 'released' }
  try {
    return { state: 'parsed', value: JSON.parse(payload) as Record<string, unknown> }
  } catch {
    return { state: 'parsed', value: {} }
  }
}

type BackfillRunRow = {
  record_id: string
  finished_at: string
  parent_run_record_id: string | null
  status: string
  failure_kind: string | null
  latest_payload: string | null
  number: number
  project_record_id: string | null
  task_record_id: string | null
  job: string
}

function backfillRunRows(database: Database): BackfillRunRow[] {
  return database
    .query<BackfillRunRow, []>(
      `SELECT r.record_id, r.number, r.job,
              COALESCE(r.last_event_at, r.started_at) AS finished_at,
              r.parent_run_record_id, r.status, r.failure_kind, latest.payload AS latest_payload,
              r.project_record_id, r.task_record_id
         FROM run r
         LEFT JOIN outbox latest ON latest.record_id = (
           SELECT prior.record_id FROM outbox prior
            WHERE prior.kind='run' AND prior.row_id=r.record_id
            ORDER BY prior.id DESC LIMIT 1
         )
        WHERE r.status IN ${RECORD_REACHABLE_RUN_STATUS_SQL}
        ORDER BY r.number`,
    )
    .all()
}

function backfillFacts(row: BackfillRunRow): RunRecordBackfillFacts {
  return {
    job: row.job,
    number: row.number,
    status: row.status,
    failureKind: row.failure_kind,
    parentRunRecordId: row.parent_run_record_id,
    projectRecordId: row.project_record_id,
    taskRecordId: row.task_record_id,
    latestPayload: readableLatestPayload(row.latest_payload),
  }
}

export function inspectRunRecordBackfill(database: Database): RunRecordBackfillInspection {
  const inspection: RunRecordBackfillInspection = {
    enqueue: 0,
    'refresh-number': 0,
    'refresh-links': 0,
    'refresh-root': 0,
    none: 0,
    released: 0,
    live: liveRunCount(database),
  }
  for (const row of backfillRunRows(database)) {
    const facts = backfillFacts(row)
    inspection[runRecordBackfillDecision(facts)]++
    if (facts.latestPayload.state === 'released' && !isSyntheticLifecycleJob(facts.job))
      inspection.released++
  }
  return inspection
}

function liveRunCount(database: Database): number {
  return database
    .query<{ count: number }, []>(`SELECT count(*) AS count FROM run WHERE status='running'`)
    .get()!.count
}

export function backfillRunRecords(database: Database, machineId: string): RunRecordBackfillResult {
  let enqueued = 0
  let refreshedLinks = 0
  let refreshedNumbers = 0
  let refreshedRoots = 0
  let skippedReleased = 0
  for (const row of backfillRunRows(database)) {
    const facts = backfillFacts(row)
    const decision = runRecordBackfillDecision(facts)
    if (facts.latestPayload.state === 'released' && !isSyntheticLifecycleJob(facts.job))
      skippedReleased++
    if (decision === 'none') continue
    const finishedAt = runRecordFinishedAt(
      database,
      row.record_id,
      row.parent_run_record_id,
      row.finished_at,
    )
    enqueueRunRecord(database, row.record_id, machineId, finishedAt)
    if (decision === 'enqueue') enqueued++
    else if (decision === 'refresh-number') refreshedNumbers++
    else if (decision === 'refresh-links') refreshedLinks++
    else refreshedRoots++
  }

  const skippedLive = liveRunCount(database)
  return {
    enqueued,
    refreshedLinks,
    refreshedNumbers,
    refreshedRoots,
    skippedReleased,
    skippedLive,
  }
}

/** Repairs record-reachable run rows as the run-outbox phase of machine sweep. */
export function backfillRunRecordsForSweep(): RunRecordBackfillResult {
  const database = writableDb()
  return writeTransaction(() => backfillRunRecords(database, machineId()), database)
}
