// concern: record-sync
/** Batches local outbox rows for the hosted API and applies authoritative per-row results. */
import type { Database } from 'bun:sqlite'
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
  outboxRowIsEligible,
  outboxRowWaitsForParent,
} from './outbox-dependency.ts'
import { quarantinedOutboxRows, quarantineOutboxRow } from './outbox-quarantine.ts'
import { RecordApiRequestError, recordApiClient } from './record-api-client.ts'
import { pullRecordCache } from './record-cache.ts'
import {
  RECORD_SYNC_BATCH_SIZE,
  type RecordSyncRequestRow,
  type RecordSyncResponse,
} from './record-sync-contract.ts'
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

function outboxProjectName(kind: string, record: Payload | null, local: Database): string | null {
  if (typeof record?.projectName === 'string' && record.projectName) return record.projectName
  if (kind === 'score' && record) {
    return (
      local
        .query<{ name: string }, [string]>(
          'SELECT project.name FROM run JOIN project ON project.id=run.project_id WHERE run.record_id=?',
        )
        .get(String(record.id))?.name ?? null
    )
  }
  if ((kind === 'review_lens' || kind === 'review_finding') && record) {
    return (
      local
        .query<{ name: string }, [string]>(
          'SELECT project.name FROM review JOIN project ON project.id=review.project_id WHERE review.record_id=?',
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
      'hosted record API predates evidence sync; release the hosted API, then retry `orch sync`',
    )
  }
  throw error
}

type PlannedBatchRow =
  | { disposition: 'include'; request: RecordSyncRequestRow }
  | { disposition: 'skip' }
  | { disposition: 'stop' }

function planBatchRow(
  row: OutboxRow,
  input: {
    local: Database
    hasBatchRows: boolean
    memberships: ReturnType<typeof parseRecordSpaceMemberships>
    blocked: BlockedOutboxRow[]
    projectSpaces?: Record<string, string>
  },
): PlannedBatchRow {
  const parsed = parsedPayload(row.payload)
  if (parsed && outboxRowWaitsForParent(input.local, row, parsed)) {
    return { disposition: input.hasBatchRows ? 'stop' : 'skip' }
  }
  if (parsed && deferOutboxRow(input.local, row, parsed, input.blocked))
    return { disposition: 'skip' }
  if (!outboxRowIsEligible(input.local, row)) return { disposition: 'skip' }
  const projectName = outboxProjectName(row.kind, parsed, input.local)
  const declared = projectName
    ? declaredProjectSpace(input.local, projectName, input.projectSpaces)
    : null
  const membership = declared ? recordSpaceMembership(declared, input.memberships) : undefined
  return {
    disposition: 'include',
    request: {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      spaceHint: membership?.spaceId ?? declared,
    },
  }
}

function nextBatch(input: {
  local: Database
  attempted: Set<number>
  memberships: ReturnType<typeof parseRecordSpaceMemberships>
  blocked: BlockedOutboxRow[]
  projectSpaces?: Record<string, string>
}): { rows: RecordSyncRequestRow[]; localRows: Map<number, OutboxRow> } {
  const candidates = input.local
    .query<OutboxRow, []>(
      `SELECT id, kind, record_id, payload FROM outbox
       WHERE synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL ORDER BY id`,
    )
    .all()
    .sort((left, right) => {
      const [leftPhase, leftId] = outboxOrder(left.kind, left.id)
      const [rightPhase, rightId] = outboxOrder(right.kind, right.id)
      return leftPhase - rightPhase || leftId - rightId
    })
  const rows: RecordSyncRequestRow[] = []
  const localRows = new Map<number, OutboxRow>()
  for (const row of candidates) {
    if (input.attempted.has(row.id)) continue
    const planned = planBatchRow(row, {
      local: input.local,
      hasBatchRows: rows.length > 0,
      memberships: input.memberships,
      blocked: input.blocked,
      projectSpaces: input.projectSpaces,
    })
    if (planned.disposition === 'stop') break
    if (planned.disposition === 'skip') continue
    rows.push(planned.request)
    localRows.set(row.id, row)
    if (rows.length === RECORD_SYNC_BATCH_SIZE) break
  }
  return { rows, localRows }
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
  response: RecordSyncResponse
  attempted: Set<number>
  readOnlyDeferred: Map<string, number>
  now: () => string
}): { pushed: number; failed: number } {
  validateBatchResults(input.batch, input.response)
  let pushed = 0
  let failed = 0
  for (let index = 0; index < input.batch.length; index++) {
    const row = input.batch[index]!
    const result = input.response.results[index]!
    input.attempted.add(row.id)
    if (result.status === 'synced') {
      markOutboxRowSynced(input.local, input.localRows.get(row.id)!, input.now())
      pushed++
    } else if (result.status === 'quarantined') {
      quarantineOutboxRow(input.local, row.id, row.payload, result.reason, input.now())
      failed++
    } else {
      input.local
        .query(
          `UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=? AND payload=?
           AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
        )
        .run(result.reason, row.id, row.payload)
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
  const session = await client.whoami()
  const memberships = parseRecordSpaceMemberships(session.memberships)
  const blocked: BlockedOutboxRow[] = []
  let pushed = 0
  let failed = 0
  const readOnlyDeferred = new Map<string, number>()
  const attempted = new Set<number>()
  let sentBatch = false
  for (;;) {
    const batch = nextBatch({
      local: writableLocal,
      attempted,
      memberships,
      blocked,
      projectSpaces: options.projectSpaces,
    })
    if (noBatchRemaining(batch.rows.length, sentBatch)) break
    let response: RecordSyncResponse
    try {
      response = await client.sync({
        machine: { ...identity, seenAt: (options.now ?? nowIso)() },
        rows: batch.rows,
      })
    } catch (error) {
      syncRouteError(error)
    }
    sentBatch = true
    const applied = applyBatchResults({
      local: writableLocal,
      batch: batch.rows,
      localRows: batch.localRows,
      response,
      attempted,
      readOnlyDeferred,
      now: options.now ?? nowIso,
    })
    pushed += applied.pushed
    failed += applied.failed
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
