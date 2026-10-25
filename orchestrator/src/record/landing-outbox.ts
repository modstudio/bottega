// concern: landing-outbox
/** Knows how local landing history and operational evidence become hosted-record mutations. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { hasRecordIdShape, newRecordId } from '../../../shared/record-id.ts'
import { machineId } from './machine-identity.ts'

import { type OutboxSanitizeKind, stringifyOutboxPayload } from './outbox-sanitize.ts'

export type LandingEvidenceBackfillResult = {
  enqueuedLandings: number
  enqueuedOverrides: number
  enqueuedCarries: number
  enqueuedTriageSnapshots: number
  enqueuedContentions: number
  enqueuedFlakes: number
  enqueuedPullRequestCi: number
}

type LocalRow = Record<string, unknown>
const json = (value: unknown): unknown => (value == null ? null : JSON.parse(String(value)))
const nowIso = (): string => new Date().toISOString()
const enqueue = (
  database: Database,
  kind: string,
  recordId: string,
  value: Record<string, unknown>,
  at: string,
): void => {
  const payload =
    kind === 'landing_review_carry' || kind === 'landing_triage_snapshot'
      ? JSON.stringify(value)
      : stringifyOutboxPayload(kind as OutboxSanitizeKind, value)
  database
    .query('INSERT INTO outbox (record_id, kind, row_id, payload, created_at) VALUES (?,?,?,?,?)')
    .run(newRecordId(), kind, recordId, payload, at)
}

function buildLandingRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId,
    localId: null,
    branch: row.branch,
    tip: row.tip,
    trunkBefore: row.trunk_before,
    status: row.status,
    error: row.error,
    sessionId: row.session_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pathSet: json(row.path_set),
    requestedAt: row.requested_at,
    steps: json(row.steps),
    causingLandingId: row.causing_landing_record_id,
    createdAt: row.started_at,
    updatedAt: at,
  }
}

function buildLandingOverrideRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId,
    localId: null,
    branch: row.branch,
    tip: row.tip,
    tree: row.tree,
    patchId: row.patch_id,
    pathSet: json(row.path_set),
    reason: row.reason,
    attribution: row.attribution,
    missingLenses: json(row.missing_lenses),
    sessionId: row.session_id,
    at: row.at,
    createdAt: row.at,
    updatedAt: at,
  }
}

function buildLandingReviewCarryRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId,
    localId: null,
    branch: row.branch,
    tip: row.tip,
    tree: row.tree,
    reviewId: row.review_record_id,
    reviewedCommit: row.reviewed_commit,
    reviewedTree: row.reviewed_tree,
    patchId: row.patch_id,
    oldBase: row.old_base,
    newBase: row.new_base,
    sessionId: row.session_id,
    at: row.at,
    createdAt: row.at,
    updatedAt: at,
  }
}

function buildLandingTriageSnapshotRecordPayload(row: LocalRow, machineId: string, at: string) {
  const reviewRecordIds = json(row.review_record_ids)
  if (
    !Array.isArray(reviewRecordIds) ||
    reviewRecordIds.some((id) => !hasRecordIdShape(String(id)))
  ) {
    throw new Error('landing triage snapshot review_record_ids must be a UUID array')
  }
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId,
    localId: null,
    branch: row.branch,
    tip: row.tip,
    tree: row.tree,
    prNumber: row.pr_number,
    reviewIds: reviewRecordIds,
    patchId: row.patch_id,
    tier: row.tier,
    lensRounds: row.lens_rounds,
    findingCount: row.finding_count,
    admissionPath: row.admission_path,
    readId: row.read_record_id,
    overrideId: row.override_record_id,
    sessionId: row.session_id,
    at: row.at,
    createdAt: row.at,
    updatedAt: at,
  }
}

function buildContentionRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    machineId,
    localId: null,
    at: row.at,
    sessionId: row.session_id,
    resourceKind: row.resource_kind,
    resourceKey: row.resource_key,
    eventKind: row.event_kind,
    durationMs: row.duration_ms,
    cause: row.cause,
    runId: row.run_record_id,
    landingId: row.landing_record_id,
    createdAt: row.at,
    updatedAt: at,
  }
}

function buildTestFlakeRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectName: null,
    machineId,
    localId: null,
    test: row.test,
    file: row.file,
    loadAtFailure: json(row.load_at_failure),
    signal: row.signal,
    at: row.at,
    createdAt: row.at,
    updatedAt: at,
  }
}

function buildPullRequestCiPayload(row: LocalRow, machine: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    machineId: machine,
    localId: null,
    prNumber: row.pr_number,
    recordKind: row.record_kind,
    complete: row.complete == null ? null : Boolean(row.complete),
    error: row.error,
    workflowRunId: row.workflow_run_id,
    runAttempt: row.run_attempt,
    workflowName: row.workflow_name,
    event: row.event,
    headCommit: row.head_commit,
    conclusion: row.conclusion,
    failedJobs: json(row.failed_jobs),
    workflowCreatedAt: row.workflow_created_at,
    workflowCompletedAt: row.workflow_completed_at,
    recordedAt: row.recorded_at,
    createdAt: row.recorded_at,
    updatedAt: at,
  }
}

export function enqueuePullRequestCi(database: Database, recordId: string, at = nowIso()): void {
  const row = database
    .query<LocalRow, [string]>(`SELECT ci.*,project.name AS project_name
    FROM pull_request_ci ci LEFT JOIN project ON project.record_id=ci.project_record_id
    WHERE ci.record_id=?`)
    .get(recordId)
  if (!row) throw new Error(`pull request CI record ${recordId} does not exist`)
  const value = buildPullRequestCiPayload(row, machineId(), at)
  const pending = database
    .query<{ id: number }, [string]>(
      "SELECT id FROM outbox WHERE kind='pull_request_ci' AND row_id=? AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(recordId)
  if (pending) {
    database
      .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
      .run(stringifyOutboxPayload('pull_request_ci', value), at, pending.id)
  } else {
    enqueue(database, 'pull_request_ci', recordId, value, at)
  }
}

function enqueueLanding(database: Database, recordId: string, at = nowIso()): void {
  const row = database
    .query<LocalRow, [string]>(
      `SELECT landing.record_id,landing.branch,landing.tip,landing.trunk_before,landing.status,
              landing.error,landing.session_id,landing.started_at,landing.finished_at,landing.path_set,
              landing.requested_at,landing.steps,landing.causing_landing_record_id,
              project.name AS project_name, project.record_id AS project_record_id
       FROM landing LEFT JOIN project ON project.record_id=landing.project_record_id
       WHERE landing.record_id=?`,
    )
    .get(recordId)
  if (!row) throw new Error(`landing ${recordId} does not exist and cannot be enqueued`)
  const value = buildLandingRecordPayload(row, machineId(), at)
  enqueue(database, 'landing', String(row.record_id), value, at)
}

export function enqueueLandingOverride(database: Database, recordId: string, at = nowIso()): void {
  const row = database
    .query<LocalRow, [string]>(
      `SELECT landing_override.record_id,landing_override.branch,landing_override.tip,landing_override.tree,
              landing_override.patch_id,landing_override.path_set,landing_override.reason,
              landing_override.attribution,landing_override.missing_lenses,
              landing_override.session_id,landing_override.at,
              project.name AS project_name, project.record_id AS project_record_id FROM landing_override
       LEFT JOIN project ON project.record_id=landing_override.project_record_id WHERE landing_override.record_id=?`,
    )
    .get(recordId)
  if (!row) throw new Error(`landing override ${recordId} does not exist and cannot be enqueued`)
  const value = buildLandingOverrideRecordPayload(row, machineId(), at)
  enqueue(database, 'landing_override', String(row.record_id), value, at)
}

export function enqueueLandingTriageSnapshot(
  database: Database,
  recordId: string,
  at = nowIso(),
): void {
  const row = database
    .query<LocalRow, [string]>(
      `SELECT snapshot.record_id,snapshot.branch,snapshot.tip,snapshot.tree,snapshot.pr_number,
              snapshot.review_record_ids,snapshot.patch_id,snapshot.tier,snapshot.lens_rounds,
              snapshot.finding_count,snapshot.admission_path,snapshot.override_record_id,snapshot.at,
              snapshot.read_record_id,snapshot.session_id,
              project.name AS project_name, project.record_id AS project_record_id
       FROM landing_triage_snapshot snapshot
       LEFT JOIN project ON project.record_id=snapshot.project_record_id
       WHERE snapshot.record_id=?`,
    )
    .get(recordId)
  if (!row?.record_id) throw new Error(`landing triage snapshot ${recordId} does not exist`)
  enqueue(
    database,
    'landing_triage_snapshot',
    String(row.record_id),
    buildLandingTriageSnapshotRecordPayload(row, machineId(), at),
    at,
  )
}

function enqueueLandingReviewCarry(database: Database, recordId: string, at = nowIso()): void {
  const row = database
    .query<LocalRow, [string]>(
      `SELECT carry.record_id,carry.branch,carry.tip,carry.tree,carry.review_record_id,
              carry.reviewed_commit,carry.reviewed_tree,carry.patch_id,carry.old_base,carry.new_base,
              carry.session_id,carry.at,project.name AS project_name, project.record_id AS project_record_id
       FROM landing_review_carry carry LEFT JOIN project ON project.record_id=carry.project_record_id
       WHERE carry.record_id=?`,
    )
    .get(recordId)
  if (!row)
    throw new Error(`landing review carry ${recordId} does not exist and cannot be enqueued`)
  const value = buildLandingReviewCarryRecordPayload(row, machineId(), at)
  enqueue(database, 'landing_review_carry', String(row.record_id), value, at)
}

export function enqueueContention(database: Database, recordId: string, at = nowIso()): void {
  const row = database
    .query<LocalRow, [string]>(
      `SELECT contention.record_id,contention.at,contention.session_id,contention.resource_kind,
              contention.resource_key,contention.event_kind,contention.duration_ms,contention.cause,
              contention.landing_record_id,run.record_id AS run_record_id
       FROM contention LEFT JOIN run ON run.record_id=contention.run_record_id
       WHERE contention.record_id=?`,
    )
    .get(recordId)
  if (!row) throw new Error(`contention ${recordId} does not exist and cannot be enqueued`)
  const value = buildContentionRecordPayload(row, machineId(), at)
  enqueue(database, 'contention', String(row.record_id), value, at)
}

function enqueueTestFlake(database: Database, recordId: string, at = nowIso()): void {
  const row = database
    .query<LocalRow, [string]>(
      'SELECT record_id,test,file,load_at_failure,signal,at FROM test_flake WHERE record_id=?',
    )
    .get(recordId)
  if (!row) throw new Error(`test flake ${recordId} does not exist and cannot be enqueued`)
  const value = buildTestFlakeRecordPayload(row, machineId(), at)
  enqueue(database, 'test_flake', String(row.record_id), value, at)
}

export function backfillLandingEvidenceRecords(database: Database): LandingEvidenceBackfillResult {
  const backfill = (table: string, kind: string, enqueueRow: (recordId: string) => void) => {
    const rows = database
      .query<{ record_id: string }, [string]>(
        `SELECT record_id FROM ${table} WHERE NOT EXISTS
         (SELECT 1 FROM outbox WHERE kind=? AND row_id=${table}.record_id) ORDER BY record_id`,
      )
      .all(kind)
    for (const row of rows) enqueueRow(row.record_id)
    return rows.length
  }
  return {
    enqueuedLandings: backfill('landing', 'landing', (id) => enqueueLanding(database, id)),
    enqueuedOverrides: backfill('landing_override', 'landing_override', (id) =>
      enqueueLandingOverride(database, id),
    ),
    enqueuedCarries: backfill('landing_review_carry', 'landing_review_carry', (id) =>
      enqueueLandingReviewCarry(database, id),
    ),
    enqueuedTriageSnapshots: backfill('landing_triage_snapshot', 'landing_triage_snapshot', (id) =>
      enqueueLandingTriageSnapshot(database, id),
    ),
    enqueuedContentions: backfill('contention', 'contention', (id) =>
      enqueueContention(database, id),
    ),
    enqueuedFlakes: backfill('test_flake', 'test_flake', (id) => enqueueTestFlake(database, id)),
    enqueuedPullRequestCi: backfill('pull_request_ci', 'pull_request_ci', (id) =>
      enqueuePullRequestCi(database, id),
    ),
  }
}
