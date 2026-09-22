// concern: run-outbox
/** Knows how a terminal local run becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { newRecordId, PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from './synthetic-lifecycle-job.ts'

export const RUN_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'projectName',
  'machineId',
  'localId',
  'startedByUserId',
  'startedAt',
  'finishedAt',
  'agent',
  'job',
  'promptSha',
  'specSha',
  'promptBytes',
  'promptHead',
  'taskKey',
  'label',
  'lens',
  'latencyMs',
  'exitCode',
  'outputBytes',
  'vendorTokens',
  'vendorCostUsd',
  'probe',
  'failureKind',
  'status',
  'error',
  'retryOf',
  'parentRunId',
  'turn',
  'filesChanged',
  'changedPaths',
  'linesAdded',
  'linesRemoved',
  'testsRan',
  'testsPassed',
  'deviations',
  'escalations',
  'stack',
  'model',
  'evidenceExcluded',
  'inputTree',
  'headCommit',
  'reviewRef',
  'branch',
  'baseCommit',
  'mintedBranch',
  'docsInjected',
  'docRevisions',
  'canonSha',
  'transport',
  'sessionId',
  'routeReason',
  'noFailover',
  'automaticFailover',
  'outsideWorktreeWrites',
  'reviewProvenance',
  'provenanceStatus',
  'workPreserved',
  'closeOutOutcome',
  'closeOutDetail',
  'createdAt',
  'updatedAt',
] as const

type LocalRun = Record<string, unknown> & {
  id: number
  record_id: string
  project_name: string | null
  started_at: string
  retry_record_id: string | null
  parent_record_id: string | null
}

type EnqueueRun = LocalRun & {
  retry_of: number | null
  parent_run_id: number | null
}

export type RunRecordBackfillResult = {
  minted: number
  enqueued: number
  skippedLive: number
}

function json(value: unknown): unknown {
  return value == null ? null : JSON.parse(String(value))
}

/** Terminal payloads use last_event_at as finished_at when present, otherwise started_at. */
export function buildRunRecordPayload(
  row: LocalRun,
  machineId: string,
  finishedAt: string,
): Record<string, unknown> {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectName: row.project_name,
    machineId,
    localId: row.id,
    startedByUserId: row.started_by_user_id,
    startedAt: row.started_at,
    finishedAt,
    agent: row.agent,
    job: row.job,
    promptSha: row.prompt_sha,
    specSha: row.spec_sha,
    promptBytes: row.prompt_bytes,
    promptHead: row.prompt_head,
    taskKey: row.launch_key,
    label: row.label,
    lens: row.lens,
    latencyMs: row.latency_ms,
    exitCode: row.exit_code,
    outputBytes: row.output_bytes,
    vendorTokens: row.vendor_tokens,
    vendorCostUsd: row.vendor_cost_usd,
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
    deviations: row.deviations,
    escalations: row.escalations,
    stack: row.stack,
    model: row.model,
    evidenceExcluded: row.evidence_excluded,
    inputTree: row.input_tree,
    headCommit: row.head_commit,
    reviewRef: row.review_ref,
    branch: row.branch,
    baseCommit: row.base_commit,
    mintedBranch: row.minted_branch,
    docsInjected: row.docs_injected,
    docRevisions: json(row.doc_revisions),
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
    createdAt: row.started_at,
    updatedAt: finishedAt,
  }
}

export function enqueueRunRecord(
  database: Database,
  runId: number,
  machineId: string,
  finishedAt: string,
): void {
  const row = database
    .query<EnqueueRun, [number]>(
      `SELECT r.*, project.name AS project_name,
              retry.record_id AS retry_record_id, parent.record_id AS parent_record_id
         FROM run r
         LEFT JOIN project ON project.id=r.project_id
         LEFT JOIN run retry ON retry.id=r.retry_of
         LEFT JOIN run parent ON parent.id=r.parent_run_id
        WHERE r.id=?`,
    )
    .get(runId)
  if (!row) throw new Error(`run ${runId} does not exist and cannot be enqueued`)
  if (row.retry_of !== null && row.retry_record_id === null) {
    throw new Error(`run ${runId} has retry_of ${row.retry_of} without a record id`)
  }
  if (row.parent_run_id !== null && row.parent_record_id === null) {
    throw new Error(`run ${runId} has parent_run_id ${row.parent_run_id} without a record id`)
  }
  const payload = buildRunRecordPayload(row, machineId, finishedAt)
  database
    .query(
      `INSERT INTO outbox (kind, record_id, payload, created_at)
       VALUES ('run', ?, ?, ?)`,
    )
    .run(row.record_id, JSON.stringify(payload), finishedAt)
}

export function backfillRunRecords(database: Database, machineId: string): RunRecordBackfillResult {
  const missing = database
    .query<{ id: number }, [string, string]>(
      'SELECT id FROM run WHERE record_id IS NULL AND job NOT IN (?,?) ORDER BY id',
    )
    .all(HOOK_TREE_JOB, LANDING_TREE_JOB)
  for (const row of missing) {
    database.query('UPDATE run SET record_id=? WHERE id=?').run(newRecordId(), row.id)
  }

  const terminal = database
    .query<{ id: number; finished_at: string }, [string, string]>(
      `SELECT r.id, COALESCE(r.last_event_at, r.started_at) AS finished_at
           FROM run r
          WHERE r.status IN ('ok', 'failed', 'stale', 'stopped', 'asking')
            AND r.job NOT IN (?,?)
            AND NOT EXISTS (
              SELECT 1 FROM outbox WHERE kind='run' AND record_id=r.record_id
            )
          ORDER BY r.id`,
    )
    .all(HOOK_TREE_JOB, LANDING_TREE_JOB)
  for (const row of terminal) enqueueRunRecord(database, row.id, machineId, row.finished_at)

  const skippedLive = database
    .query<{ count: number }, []>(`SELECT count(*) AS count FROM run WHERE status='running'`)
    .get()!.count
  return { minted: missing.length, enqueued: terminal.length, skippedLive }
}
