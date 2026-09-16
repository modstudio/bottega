// concern: landing-outbox
/** Knows how local landing history and operational evidence become hosted-record mutations. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { newRecordId, PLATFORM_SPACE_ID } from '../../shared/record/schema.ts'

export const LANDING_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'projectName',
  'machineId',
  'localId',
  'branch',
  'tip',
  'trunkBefore',
  'status',
  'error',
  'sessionId',
  'startedAt',
  'finishedAt',
  'pathSet',
  'requestedAt',
  'steps',
  'causingLandingId',
  'createdAt',
  'updatedAt',
] as const
export const LANDING_OVERRIDE_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'projectName',
  'machineId',
  'localId',
  'branch',
  'tip',
  'tree',
  'reason',
  'sessionId',
  'at',
  'createdAt',
  'updatedAt',
] as const
export const LANDING_REVIEW_CARRY_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'projectName',
  'machineId',
  'localId',
  'branch',
  'tip',
  'tree',
  'reviewId',
  'reviewedCommit',
  'reviewedTree',
  'patchId',
  'oldBase',
  'newBase',
  'sessionId',
  'at',
  'createdAt',
  'updatedAt',
] as const
export const CONTENTION_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'machineId',
  'localId',
  'at',
  'sessionId',
  'resourceKind',
  'resourceKey',
  'eventKind',
  'durationMs',
  'cause',
  'runId',
  'landingId',
  'createdAt',
  'updatedAt',
] as const
export const TEST_FLAKE_RECORD_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'projectName',
  'machineId',
  'localId',
  'test',
  'file',
  'loadAtFailure',
  'signal',
  'at',
  'createdAt',
  'updatedAt',
] as const

export type LandingEvidenceBackfillResult = {
  mintedLandings: number
  mintedOverrides: number
  mintedCarries: number
  mintedContentions: number
  mintedFlakes: number
  enqueuedLandings: number
  enqueuedOverrides: number
  enqueuedCarries: number
  enqueuedContentions: number
  enqueuedFlakes: number
}

type LocalRow = Record<string, unknown>
const json = (value: unknown): unknown => (value == null ? null : JSON.parse(String(value)))
const nowIso = (): string => new Date().toISOString()
const localMachineId = (database: Database): string => {
  const row = database
    .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='machine_id'")
    .get()
  if (row) return row.value
  const id = newRecordId()
  database.query("INSERT INTO schema_meta (key, value) VALUES ('machine_id', ?)").run(id)
  return id
}
const enqueue = (
  database: Database,
  kind: string,
  recordId: string,
  value: object,
  at: string,
): void => {
  database
    .query('INSERT INTO outbox (kind, record_id, payload, created_at) VALUES (?,?,?,?)')
    .run(kind, recordId, JSON.stringify(value), at)
}

function buildLandingRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectName: row.project_name,
    machineId,
    localId: row.id,
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
    projectName: row.project_name,
    machineId,
    localId: row.id,
    branch: row.branch,
    tip: row.tip,
    tree: row.tree,
    reason: row.reason,
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
    projectName: row.project_name,
    machineId,
    localId: row.id,
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

function buildContentionRecordPayload(row: LocalRow, machineId: string, at: string) {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    machineId,
    localId: row.id,
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
    localId: row.id,
    test: row.test,
    file: row.file,
    loadAtFailure: json(row.load_at_failure),
    signal: row.signal,
    at: row.at,
    createdAt: row.at,
    updatedAt: at,
  }
}

function enqueueLanding(database: Database, id: number, at = nowIso()): void {
  const row = database
    .query<LocalRow, [number]>(
      `SELECT landing.*, project.name AS project_name,
              cause.record_id AS causing_landing_record_id
       FROM landing LEFT JOIN project ON project.id=landing.project_id
       LEFT JOIN landing cause ON cause.id=landing.causing_landing_id WHERE landing.id=?`,
    )
    .get(id)
  if (!row?.record_id) throw new Error(`landing ${id} has no record id`)
  if (row.causing_landing_id != null && row.causing_landing_record_id == null)
    throw new Error(`landing ${id} has a causing landing without a record id`)
  const value = buildLandingRecordPayload(row, localMachineId(database), at)
  enqueue(database, 'landing', String(row.record_id), value, at)
}

function enqueueLandingOverride(database: Database, id: number, at = nowIso()): void {
  const row = database
    .query<LocalRow, [number]>(
      `SELECT landing_override.*, project.name AS project_name FROM landing_override
       LEFT JOIN project ON project.id=landing_override.project_id WHERE landing_override.id=?`,
    )
    .get(id)
  if (!row?.record_id) throw new Error(`landing override ${id} has no record id`)
  const value = buildLandingOverrideRecordPayload(row, localMachineId(database), at)
  enqueue(database, 'landing_override', String(row.record_id), value, at)
}

function enqueueLandingReviewCarry(database: Database, id: number, at = nowIso()): void {
  const row = database
    .query<LocalRow, [number]>(
      `SELECT carry.*, project.name AS project_name, review.record_id AS review_record_id
       FROM landing_review_carry carry LEFT JOIN project ON project.id=carry.project_id
       JOIN review ON review.id=carry.review_id WHERE carry.id=?`,
    )
    .get(id)
  if (!row?.record_id) throw new Error(`landing review carry ${id} has no record id`)
  if (!row.review_record_id)
    throw new Error(`landing review carry ${id} has a review without a record id`)
  const value = buildLandingReviewCarryRecordPayload(row, localMachineId(database), at)
  enqueue(database, 'landing_review_carry', String(row.record_id), value, at)
}

export function enqueueContention(database: Database, id: number, at = nowIso()): void {
  const row = database
    .query<LocalRow, [number]>(
      `SELECT contention.*, run.record_id AS run_record_id,
              landing.record_id AS landing_record_id
       FROM contention LEFT JOIN run ON run.id=contention.run_id
       LEFT JOIN landing ON landing.id=contention.landing_id WHERE contention.id=?`,
    )
    .get(id)
  if (!row?.record_id) throw new Error(`contention ${id} has no record id`)
  if (row.run_id != null && row.run_record_id == null)
    throw new Error(`contention ${id} has a run without a record id`)
  if (row.landing_id != null && row.landing_record_id == null)
    throw new Error(`contention ${id} has a landing without a record id`)
  const value = buildContentionRecordPayload(row, localMachineId(database), at)
  enqueue(database, 'contention', String(row.record_id), value, at)
}

function enqueueTestFlake(database: Database, id: number, at = nowIso()): void {
  const row = database.query<LocalRow, [number]>('SELECT * FROM test_flake WHERE id=?').get(id)
  if (!row?.record_id) throw new Error(`test flake ${id} has no record id`)
  const value = buildTestFlakeRecordPayload(row, localMachineId(database), at)
  enqueue(database, 'test_flake', String(row.record_id), value, at)
}

export function backfillLandingEvidenceRecords(database: Database): LandingEvidenceBackfillResult {
  const mint = (table: string) => {
    const rows = database
      .query<{ id: number }, []>(`SELECT id FROM ${table} WHERE record_id IS NULL ORDER BY id`)
      .all()
    for (const row of rows)
      database.query(`UPDATE ${table} SET record_id=? WHERE id=?`).run(newRecordId(), row.id)
    return rows.length
  }
  const mintedLandings = mint('landing')
  const mintedOverrides = mint('landing_override')
  const mintedCarries = mint('landing_review_carry')
  const mintedContentions = mint('contention')
  const mintedFlakes = mint('test_flake')
  const backfill = (table: string, kind: string, enqueueRow: (id: number) => void) => {
    const rows = database
      .query<{ id: number }, [string]>(
        `SELECT id FROM ${table} WHERE NOT EXISTS
         (SELECT 1 FROM outbox WHERE kind=? AND record_id=${table}.record_id) ORDER BY id`,
      )
      .all(kind)
    for (const row of rows) enqueueRow(row.id)
    return rows.length
  }
  return {
    mintedLandings,
    mintedOverrides,
    mintedCarries,
    mintedContentions,
    mintedFlakes,
    enqueuedLandings: backfill('landing', 'landing', (id) => enqueueLanding(database, id)),
    enqueuedOverrides: backfill('landing_override', 'landing_override', (id) =>
      enqueueLandingOverride(database, id),
    ),
    enqueuedCarries: backfill('landing_review_carry', 'landing_review_carry', (id) =>
      enqueueLandingReviewCarry(database, id),
    ),
    enqueuedContentions: backfill('contention', 'contention', (id) =>
      enqueueContention(database, id),
    ),
    enqueuedFlakes: backfill('test_flake', 'test_flake', (id) => enqueueTestFlake(database, id)),
  }
}
