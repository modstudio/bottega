// concern: run-outbox
/** Knows how a terminal local run becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { hasRecordIdShape, newRecordId } from '../../../shared/record-id.ts'

import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import { chainTerminationAtForRoot } from './run-chain.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from './synthetic-lifecycle-job.ts'

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
  refreshedRoots: number
  skippedLive: number
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

/** Terminal payloads use last_event_at as finished_at when present, otherwise started_at. */
export function buildRunRecordPayload(
  row: LocalRun,
  machineId: string,
  finishedAt: string,
  evidenceUnvoid: { note: string } | null = null,
): Record<string, unknown> {
  return {
    id: row.record_id,
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
    taskKey: row.launch_key,
    label: row.label,
    lens: row.lens,
    latencyMs: row.latency_ms,
    exitCode: row.exit_code,
    outputBytes: row.output_bytes,
    vendorTokens: row.vendor_tokens,
    vendorCostUsd: row.vendor_cost_usd,
    vendorInputTokens: row.vendor_input_tokens,
    vendorOutputTokens: row.vendor_output_tokens,
    vendorEstimatedCostUsd: row.vendor_estimated_cost_usd,
    vendorCostSource: row.vendor_cost_source,
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
    deviations: row.deviations,
    escalations: row.escalations,
    stack: row.stack,
    model: row.model,
    evidenceExcluded: row.evidence_excluded,
    evidenceUnvoid,
    inputTree: row.input_tree,
    headCommit: row.head_commit,
    reviewRef: row.review_ref,
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
  database
    .query(
      `INSERT INTO outbox (record_id, kind, row_id, payload, created_at)
       VALUES (?, 'run', ?, ?, ?)`,
    )
    .run(newRecordId(), row.record_id, payload, finishedAt)
}

export function backfillRunRecords(database: Database, machineId: string): RunRecordBackfillResult {
  const eligible = database
    .query<
      {
        record_id: string
        finished_at: string
        parent_run_record_id: string | null
        status: string
        failure_kind: string | null
        latest_payload: string | null
      },
      [string, string]
    >(
      `SELECT r.record_id, COALESCE(r.last_event_at, r.started_at) AS finished_at,
              r.parent_run_record_id, r.status, r.failure_kind, latest.payload AS latest_payload
         FROM run r
         LEFT JOIN outbox latest ON latest.record_id = (
           SELECT prior.record_id FROM outbox prior
            WHERE prior.kind='run' AND prior.row_id=r.record_id
            ORDER BY prior.id DESC LIMIT 1
         )
        WHERE r.status IN ('ok', 'failed', 'stale', 'stopped', 'asking')
          AND r.job NOT IN (?,?)
        ORDER BY r.number`,
    )
    .all(HOOK_TREE_JOB, LANDING_TREE_JOB)
  let enqueued = 0
  let refreshedRoots = 0
  for (const row of eligible) {
    if (row.latest_payload === null) {
      enqueueRunRecord(database, row.record_id, machineId, row.finished_at)
      enqueued++
      continue
    }
    if (row.parent_run_record_id !== null) continue
    let latest: { status?: unknown; failureKind?: unknown }
    try {
      latest = JSON.parse(row.latest_payload) as typeof latest
    } catch {
      latest = {}
    }
    if (latest.status === row.status && latest.failureKind === row.failure_kind) continue
    const chainTermination = chainTerminationAtForRoot(database, row.record_id) ?? row.finished_at
    enqueueRunRecord(database, row.record_id, machineId, chainTermination)
    refreshedRoots++
  }

  const skippedLive = database
    .query<{ count: number }, []>(`SELECT count(*) AS count FROM run WHERE status='running'`)
    .get()!.count
  return { enqueued, refreshedRoots, skippedLive }
}
