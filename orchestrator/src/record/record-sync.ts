// concern: record-sync
/** Batches local outbox rows for the hosted API and applies authoritative per-row results. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { db, nowIso } from '../database/db.ts'
import { backfillReleaseRecords } from '../release/release-outbox.ts'
import { backfillReviewRecords } from '../review/review-outbox.ts'
import { backfillQuestionRecords } from '../run/question-outbox.ts'
import { backfillRunRecords } from '../run/run-outbox.ts'
import { backfillScoreRecords } from '../score/score-outbox.ts'
import { rememberHostedRecord } from './install-binding.ts'
import { backfillLandingEvidenceRecords } from './landing-outbox.ts'
import { machineId, machineName } from './machine-identity.ts'
import {
  deferOutboxRow,
  markOutboxRowSynced,
  outboxParentIdentityKey,
  outboxRowIsEligible,
  outboxRowPlannedParentKeys,
  outboxRowWaitsForParent,
} from './outbox-dependency.ts'
import { quarantinedOutboxRows, quarantineOutboxRow } from './outbox-quarantine.ts'
import { RecordApiRequestError, recordApiClient } from './record-api-client.ts'
import { pullRecordCache } from './record-cache.ts'
import { type OversizedRecordSyncRow, planRecordSyncBatch } from './record-sync-batch.ts'
import {
  RECORD_SYNC_BATCH_SIZE,
  RECORD_SYNC_CLIENT_MAX_REQUEST_BYTES,
  RECORD_SYNC_MAX_PAYLOAD_BYTES,
  type RecordSyncRequest,
  type RecordSyncRequestRow,
  type RecordSyncResponse,
} from './record-sync-contract.ts'
import {
  type RecordSyncBatchDependency,
  recordSyncResultTreatments,
} from './record-sync-result-decision.ts'
import type {
  BlockedOutboxRow,
  OutboxRow,
  Payload,
  RecordSyncOptions,
  RecordSyncResult,
} from './record-sync-types.ts'

export type {
  RecordSyncOptions,
  RecordSyncResult,
} from './record-sync-types.ts'

export function outboxOrder(kind: string, id: number): readonly [phase: number, id: number] {
  if (kind === 'run') return [0, id]
  if (kind === 'landing_review_carry' || kind === 'landing_triage_snapshot') return [3, id]
  switch (kind) {
    case 'score':
    case 'question':
    case 'review':
    case 'review_lens':
    case 'review_finding':
    case 'review_read':
    case 'contention':
      return [2, id]
    default:
      return [1, id]
  }
}

function parsedPayload(source: string): Payload | null {
  try {
    const value = JSON.parse(source)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Payload)
      : null
  } catch {
    return null
  }
}

function runProjectName(local: Database, runRecordId: unknown): string | null {
  if (runRecordId == null) return null
  return (
    local
      .query<{ name: string }, [string]>(
        'SELECT project.name FROM run JOIN project ON project.record_id=run.project_record_id WHERE run.record_id=?',
      )
      .get(String(runRecordId))?.name ?? null
  )
}

function landingProjectName(local: Database, landingRecordId: unknown): string | null {
  if (landingRecordId == null) return null
  return (
    local
      .query<{ name: string }, [string]>(
        'SELECT project.name FROM landing JOIN project ON project.record_id=landing.project_record_id WHERE landing.record_id=?',
      )
      .get(String(landingRecordId))?.name ?? null
  )
}

function outboxProjectName(kind: string, record: Payload | null, local: Database): string | null {
  if (typeof record?.projectName === 'string' && record.projectName) return record.projectName
  if (kind === 'score' && record) {
    return runProjectName(local, record.id)
  }
  if (kind === 'contention' && record) {
    return runProjectName(local, record.runId) ?? landingProjectName(local, record.landingId)
  }
  if ((kind === 'review_lens' || kind === 'review_finding') && record) {
    return (
      local
        .query<{ name: string }, [string]>(
          'SELECT project.name FROM review JOIN project ON project.record_id=review.project_record_id WHERE review.record_id=?',
        )
        .get(String(record.reviewId))?.name ?? null
    )
  }
  return null
}

function declaredProjectSpace(
  local: Database,
  projectName: string,
  overrides?: Record<string, string>,
): string | null {
  if (overrides?.[projectName]) return overrides[projectName]!
  const hasProjects = local
    .query<{ present: number }, []>(
      "SELECT count(*) AS present FROM sqlite_master WHERE type='table' AND name='project'",
    )
    .get()?.present
  if (!hasProjects) return null
  const row = local
    .query<{ settings: string }, [string]>('SELECT settings FROM project WHERE name=?')
    .get(projectName)
  if (!row) return null
  const settings = JSON.parse(row.settings) as { space?: unknown }
  return typeof settings.space === 'string' && settings.space.trim() ? settings.space : null
}

function pendingCount(local: Database): number {
  return local
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM outbox
       WHERE synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
    )
    .get()!.count
}

function syncRouteError(error: unknown): never {
  if (error instanceof RecordApiRequestError && error.status === 404) {
    throw new Error(
      `hosted record API predates evidence sync; release the hosted API, then retry \`${PLATFORM_SLUG} record sync\``,
    )
  }
  throw error
}

type PlannedBatchRow =
  | { disposition: 'include'; request: RecordSyncRequestRow; parentKeys: string[] }
  | { disposition: 'skip' }
  | { disposition: 'stop' }

type PreparedOutboxRow = {
  row: OutboxRow
  parsed: Payload | null
  payload: string
  payloadBytes: number
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

function planBatchRow(
  candidate: PreparedOutboxRow,
  input: {
    local: Database
    hasBatchRows: boolean
    memberships: ReturnType<typeof parseRecordSpaceMemberships>
    blocked: BlockedOutboxRow[]
    plannedParents: ReadonlyMap<string, readonly number[]>
    projectSpaces?: Record<string, string>
  },
): PlannedBatchRow {
  const { row, parsed } = candidate
  if (parsed && outboxRowWaitsForParent(input.local, row, parsed, input.plannedParents)) {
    return { disposition: input.hasBatchRows ? 'stop' : 'skip' }
  }
  if (parsed && deferOutboxRow(input.local, row, parsed, input.blocked, input.plannedParents))
    return { disposition: 'skip' }
  if (!outboxRowIsEligible(input.local, row)) return { disposition: 'skip' }
  const projectName = outboxProjectName(row.kind, parsed, input.local)
  const declared = projectName
    ? declaredProjectSpace(input.local, projectName, input.projectSpaces)
    : null
  const membership = declared ? recordSpaceMembership(declared, input.memberships) : undefined
  return {
    disposition: 'include',
    parentKeys: parsed
      ? outboxRowPlannedParentKeys(input.local, row, parsed, input.plannedParents)
      : [],
    request: {
      id: row.id,
      kind: row.kind,
      payload: candidate.payload,
      spaceHint: membership?.spaceId ?? declared,
    },
  }
}

function preparePendingRows(local: Database): Set<PreparedOutboxRow> {
  const rows = local
    .query<OutboxRow, []>(
      `SELECT id, kind, row_id, payload FROM outbox
       WHERE synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL ORDER BY id`,
    )
    .all()
    .sort((left, right) => {
      const [leftPhase, leftId] = outboxOrder(left.kind, left.id)
      const [rightPhase, rightId] = outboxOrder(right.kind, right.id)
      return leftPhase - rightPhase || leftId - rightId
    })
    .map((row) => {
      const parsed = parsedPayload(row.payload)
      const payload = payloadWithProjectIdentity(local, row, parsed)
      return {
        row,
        parsed: parsedPayload(payload),
        payload,
        payloadBytes: utf8Bytes(payload),
      }
    })
  return new Set(rows)
}

function sourceProjectRecordId(local: Database, row: OutboxRow): string | null | undefined {
  const queries: Partial<Record<string, string>> = {
    run: `SELECT project.record_id FROM run
      LEFT JOIN project ON project.record_id=run.project_record_id WHERE run.record_id=?`,
    score: `SELECT project.record_id FROM run
      LEFT JOIN project ON project.record_id=run.project_record_id WHERE run.record_id=?`,
    question: `SELECT project.record_id FROM question
      LEFT JOIN run ON run.record_id=question.run_record_id
      LEFT JOIN project ON project.record_id=run.project_record_id WHERE question.record_id=?`,
    review: `SELECT project.record_id FROM review
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review.record_id=?`,
    review_lens: `SELECT project.record_id FROM review_lens
      JOIN review ON review.id=review_lens.review_id
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review_lens.record_id=?`,
    review_finding: `SELECT project.record_id FROM review_finding
      JOIN review ON review.id=review_finding.review_id
      LEFT JOIN project ON project.record_id=review.project_record_id WHERE review_finding.record_id=?`,
    review_read: `SELECT project.record_id FROM review_read
      LEFT JOIN project ON project.record_id=review_read.project_record_id WHERE review_read.record_id=?`,
    landing: `SELECT project.record_id FROM landing
      LEFT JOIN project ON project.record_id=landing.project_record_id WHERE landing.record_id=?`,
    landing_override: `SELECT project.record_id FROM landing_override
      LEFT JOIN project ON project.record_id=landing_override.project_record_id
      WHERE landing_override.record_id=?`,
    landing_review_carry: `SELECT project.record_id FROM landing_review_carry
      LEFT JOIN project ON project.record_id=landing_review_carry.project_record_id
      WHERE landing_review_carry.record_id=?`,
    landing_triage_snapshot: `SELECT project.record_id FROM landing_triage_snapshot
      LEFT JOIN project ON project.record_id=landing_triage_snapshot.project_record_id
      WHERE landing_triage_snapshot.record_id=?`,
    release: `SELECT project.record_id FROM release_ledger
      LEFT JOIN project ON project.record_id=release_ledger.project_record_id WHERE release_ledger.record_id=?`,
  }
  const query = queries[row.kind]
  if (!query) return undefined
  return (
    local.query<{ record_id: string | null }, [string]>(query).get(row.row_id)?.record_id ?? null
  )
}

function payloadWithProjectIdentity(
  local: Database,
  row: OutboxRow,
  parsed: Payload | null,
): string {
  if (!parsed || parsed.projectId != null || parsed.projectName == null) return row.payload
  const projectId = sourceProjectRecordId(local, row)
  if (projectId === undefined) return row.payload
  return JSON.stringify({
    ...parsed,
    projectId,
    ...(projectId ? {} : { projectName: null }),
  })
}

function quarantineOversizedRow(input: {
  row: OutboxRow
  oversized: OversizedRecordSyncRow
  local: Database
  attempted: Set<number>
  now: () => string
}): number {
  const changed = quarantineOutboxRow(
    input.local,
    input.row.id,
    input.row.payload,
    input.oversized.reason,
    input.now(),
  )
  input.attempted.add(input.row.id)
  return changed ? 1 : 0
}

function planTransportCandidate(
  row: OutboxRow,
  payloadBytes: number,
  serializedBytes: number,
  requestBytes: number,
  sendCount: number,
) {
  return planRecordSyncBatch({
    rows: [{ id: row.id, kind: row.kind, payloadBytes, serializedBytes }],
    emptyRequestBytes: requestBytes,
    initialSendCount: sendCount,
    payloadLimit: RECORD_SYNC_MAX_PAYLOAD_BYTES,
    requestLimit: RECORD_SYNC_CLIENT_MAX_REQUEST_BYTES,
    countLimit: RECORD_SYNC_BATCH_SIZE,
  })
}

function quarantinePayloadIfOversized(input: {
  candidateRow: PreparedOutboxRow
  candidates: Set<PreparedOutboxRow>
  local: Database
  attempted: Set<number>
  requestBytes: number
  sendCount: number
  now: () => string
}): number | null {
  const { row, payloadBytes } = input.candidateRow
  if (payloadBytes <= RECORD_SYNC_MAX_PAYLOAD_BYTES) return null
  const oversized = planTransportCandidate(
    row,
    payloadBytes,
    0,
    input.requestBytes,
    input.sendCount,
  ).quarantine[0]
  if (!oversized) throw new Error('oversized payload was not refused')
  const quarantined = quarantineOversizedRow({
    row,
    oversized,
    local: input.local,
    attempted: input.attempted,
    now: input.now,
  })
  input.candidates.delete(input.candidateRow)
  return quarantined
}

function addPlannedRow(input: {
  candidateRow: PreparedOutboxRow
  planned: Extract<PlannedBatchRow, { disposition: 'include' }>
  candidates: Set<PreparedOutboxRow>
  local: Database
  attempted: Set<number>
  rows: RecordSyncRequestRow[]
  localRows: Map<number, OutboxRow>
  dependencies: RecordSyncBatchDependency[]
  plannedParents: Map<string, number[]>
  requestBytes: number
  now: () => string
}): { disposition: 'stop' } | { disposition: 'sent'; requestBytes: number; quarantined: number } {
  const { row, payloadBytes } = input.candidateRow
  const decision = planTransportCandidate(
    row,
    payloadBytes,
    utf8Bytes(JSON.stringify(input.planned.request)),
    input.requestBytes,
    input.rows.length,
  )
  const oversized = decision.quarantine[0]
  if (oversized) {
    const quarantined = quarantineOversizedRow({
      row,
      oversized,
      local: input.local,
      attempted: input.attempted,
      now: input.now,
    })
    input.candidates.delete(input.candidateRow)
    return { disposition: 'sent', requestBytes: input.requestBytes, quarantined }
  }
  if (!decision.send.length) return { disposition: 'stop' }
  input.rows.push(input.planned.request)
  input.localRows.set(row.id, row)
  input.dependencies.push({
    id: row.id,
    sameBatchParentIdGroups: input.planned.parentKeys.map((key) => [
      ...input.plannedParents.get(key)!,
    ]),
  })
  const rowKey = outboxParentIdentityKey(row.kind, row.row_id)
  const identityRows = input.plannedParents.get(rowKey)
  if (identityRows) identityRows.push(row.id)
  else input.plannedParents.set(rowKey, [row.id])
  return { disposition: 'sent', requestBytes: decision.requestBytes, quarantined: 0 }
}

function nextBatch(input: {
  local: Database
  candidates: Set<PreparedOutboxRow>
  attempted: Set<number>
  identity: { id: string; name: string }
  now: () => string
  memberships: ReturnType<typeof parseRecordSpaceMemberships>
  blocked: BlockedOutboxRow[]
  projectSpaces?: Record<string, string>
}): {
  request: RecordSyncRequest
  localRows: Map<number, OutboxRow>
  dependencies: RecordSyncBatchDependency[]
  quarantined: number
} {
  const machine = { ...input.identity, seenAt: input.now() }
  const emptyRequestBytes = utf8Bytes(JSON.stringify({ machine, rows: [] }))
  const rows: RecordSyncRequestRow[] = []
  const localRows = new Map<number, OutboxRow>()
  const dependencies: RecordSyncBatchDependency[] = []
  const plannedParents = new Map<string, number[]>()
  let requestBytes = emptyRequestBytes
  let quarantined = 0
  for (const candidateRow of input.candidates) {
    const { row } = candidateRow
    if (input.attempted.has(row.id)) {
      input.candidates.delete(candidateRow)
      continue
    }
    const payloadQuarantine = quarantinePayloadIfOversized({
      candidateRow,
      candidates: input.candidates,
      local: input.local,
      attempted: input.attempted,
      requestBytes,
      sendCount: rows.length,
      now: input.now,
    })
    if (payloadQuarantine !== null) {
      quarantined += payloadQuarantine
      continue
    }
    const planned = planBatchRow(candidateRow, {
      local: input.local,
      hasBatchRows: rows.length > 0,
      memberships: input.memberships,
      blocked: input.blocked,
      plannedParents,
      projectSpaces: input.projectSpaces,
    })
    if (planned.disposition === 'stop') break
    if (planned.disposition === 'skip') continue
    const added = addPlannedRow({
      candidateRow,
      planned,
      candidates: input.candidates,
      local: input.local,
      attempted: input.attempted,
      rows,
      localRows,
      dependencies,
      plannedParents,
      requestBytes,
      now: input.now,
    })
    if (added.disposition === 'stop') break
    quarantined += added.quarantined
    requestBytes = added.requestBytes
    if (rows.length === RECORD_SYNC_BATCH_SIZE) break
  }
  return { request: { machine, rows }, localRows, dependencies, quarantined }
}

function validateBatchResults(batch: RecordSyncRequestRow[], response: RecordSyncResponse): void {
  if (response.results.length !== batch.length)
    throw new Error('record sync response did not contain one result per requested row')
  for (let index = 0; index < batch.length; index++) {
    const row = batch[index]!
    const result = response.results[index]!
    if (result === null || typeof result !== 'object')
      throw new Error('record sync response contained an invalid row result')
    if (result.id !== row.id)
      throw new Error('record sync response order did not match the request')
    if (!['synced', 'quarantined', 'deferred'].includes(result.status))
      throw new Error('record sync response contained an invalid row status')
    if (
      (result.status === 'quarantined' || result.status === 'deferred') &&
      (typeof result.reason !== 'string' || !result.reason.trim())
    ) {
      throw new Error('record sync response contained an invalid row reason')
    }
    if (
      result.status === 'deferred' &&
      (typeof result.spaceId !== 'string' || !result.spaceId.trim())
    ) {
      throw new Error('record sync response contained an invalid deferred space')
    }
  }
}

function applyBatchResults(input: {
  local: Database
  batch: RecordSyncRequestRow[]
  localRows: Map<number, OutboxRow>
  dependencies: RecordSyncBatchDependency[]
  response: RecordSyncResponse
  attempted: Set<number>
  readOnlyDeferred: Map<string, number>
  now: () => string
}): { pushed: number; failed: number } {
  validateBatchResults(input.batch, input.response)
  const treatments = recordSyncResultTreatments(input.dependencies, input.response.results)
  let pushed = 0
  let failed = 0
  for (let index = 0; index < input.batch.length; index++) {
    const row = input.batch[index]!
    const result = input.response.results[index]!
    const treatment = treatments[index]!
    input.attempted.add(row.id)
    if (treatment.treatment === 'pending') continue
    if (result.status === 'synced') {
      markOutboxRowSynced(input.local, input.localRows.get(row.id)!, input.now())
      pushed++
    } else if (result.status === 'quarantined') {
      quarantineOutboxRow(
        input.local,
        row.id,
        input.localRows.get(row.id)!.payload,
        result.reason,
        input.now(),
      )
      failed++
    } else {
      const source = input.localRows.get(row.id)!
      input.local
        .query(
          `UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=? AND payload=?
           AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
        )
        .run(result.reason, row.id, source.payload)
      input.readOnlyDeferred.set(
        result.spaceId,
        (input.readOnlyDeferred.get(result.spaceId) ?? 0) + 1,
      )
    }
  }
  return { pushed, failed }
}

function noBatchRemaining(rowCount: number, sentBatch: boolean): boolean {
  return rowCount === 0 && sentBatch
}

async function sendSyncBatch(input: {
  client: { sync: NonNullable<ReturnType<typeof recordApiClient>['sync']> }
  batch: ReturnType<typeof nextBatch>
  local: Database
  attempted: Set<number>
  readOnlyDeferred: Map<string, number>
  now: () => string
}): Promise<{ pushed: number; failed: number }> {
  let response: RecordSyncResponse
  try {
    response = await input.client.sync!(input.batch.request)
  } catch (error) {
    syncRouteError(error)
  }
  return applyBatchResults({
    local: input.local,
    batch: input.batch.request.rows,
    localRows: input.batch.localRows,
    dependencies: input.batch.dependencies,
    response,
    attempted: input.attempted,
    readOnlyDeferred: input.readOnlyDeferred,
    now: input.now,
  })
}

async function ensureActiveSpaceBuiltIns(
  client: Pick<ReturnType<typeof recordApiClient>, 'whoami' | 'ensureSpaceBuiltIns'>,
): Promise<Awaited<ReturnType<typeof client.whoami>>> {
  const session = await client.whoami()
  if (session.activeSpaceId && client.ensureSpaceBuiltIns)
    await client.ensureSpaceBuiltIns({ destinationSpaceId: session.activeSpaceId })
  return session
}

export async function syncRecord(options: RecordSyncOptions = {}): Promise<RecordSyncResult> {
  const configured = Boolean(resolveRecordApiUrl(process.env) || options.client)
  const identity = options.identity ?? { id: machineId(), name: machineName() }
  const local = options.local ?? (configured || options.backfill ? db() : undefined)
  const backfill = options.backfill
    ? {
        ...backfillRunRecords(local!, identity.id),
        scores: backfillScoreRecords(local!, identity.id),
        reviews: backfillReviewRecords(local!),
        landingEvidence: backfillLandingEvidenceRecords(local!),
        questions: backfillQuestionRecords(local!),
        releases: backfillReleaseRecords(local!),
      }
    : undefined
  if (!configured) {
    return {
      pushed: 0,
      failed: 0,
      pending: 0,
      configured: false,
      quarantined: [],
      blocked: [],
      ...(backfill ? { backfill } : {}),
    }
  }
  const writableLocal = local!
  const client = options.client ?? recordApiClient()
  if (!client.sync) throw new Error('record API client does not provide evidence sync')
  const session = await ensureActiveSpaceBuiltIns(client)
  const memberships = parseRecordSpaceMemberships(session.memberships)
  const blocked: BlockedOutboxRow[] = []
  let pushed = 0
  let failed = 0
  const readOnlyDeferred = new Map<string, number>()
  const attempted = new Set<number>()
  const candidates = preparePendingRows(writableLocal)
  let sentBatch = false
  for (;;) {
    const batch = nextBatch({
      local: writableLocal,
      candidates,
      attempted,
      identity,
      now: options.now ?? nowIso,
      memberships,
      blocked,
      projectSpaces: options.projectSpaces,
    })
    failed += batch.quarantined
    if (noBatchRemaining(batch.request.rows.length, sentBatch)) break
    const applied = await sendSyncBatch({
      client: { sync: client.sync },
      batch,
      local: writableLocal,
      attempted,
      readOnlyDeferred,
      now: options.now ?? nowIso,
    })
    sentBatch = true
    pushed += applied.pushed
    failed += applied.failed
    if (!batch.request.rows.length) break
  }
  if (!options.client) await pullRecordCache(writableLocal)
  rememberHostedRecord(writableLocal)
  return {
    pushed,
    failed,
    pending: pendingCount(writableLocal),
    configured: true,
    quarantined: quarantinedOutboxRows(writableLocal),
    blocked,
    ...(readOnlyDeferred.size
      ? {
          readOnlyDeferred: [...readOnlyDeferred].map(([spaceId, count]) => ({
            spaceId,
            rows: count,
          })),
        }
      : {}),
    ...(backfill ? { backfill } : {}),
  }
}
