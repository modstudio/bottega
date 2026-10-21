// concern: record-sync
/** Plain local types for hosted-record synchronization. */
import type { Database } from 'bun:sqlite'
import type { backfillReleaseRecords } from '../release/release-outbox.ts'
import type { ReviewRecordBackfillResult } from '../review/review-outbox.ts'
import type { RunRecordBackfillResult } from '../run/run-outbox.ts'
import type { LandingEvidenceBackfillResult } from './landing-outbox.ts'
import type { QuarantinedOutboxRow } from './outbox-quarantine.ts'
import type { RecordApiClient } from './record-api-client.ts'

export type OutboxRow = { id: number; kind: string; row_id: string; payload: string }
export type { RecordPayload as Payload } from './record-sync-contract.ts'
export type BlockedOutboxRow = {
  id: number
  kind: string
  parentRecordId: string
  reason?: string
}
export type HeldRecordSyncRows = { kind: string; rows: number; reason: string }

export type RecordSyncResult = {
  pushed: number
  failed: number
  pending: number
  configured: boolean
  quarantined: QuarantinedOutboxRow[]
  blocked: BlockedOutboxRow[]
  held?: HeldRecordSyncRows[]
  readOnlyDeferred?: { spaceId: string; rows: number }[]
  backfill?: RunRecordBackfillResult & {
    scores: number
    reviews: ReviewRecordBackfillResult
    landingEvidence: LandingEvidenceBackfillResult
    questions: { enqueued: number }
    releases: ReturnType<typeof backfillReleaseRecords>
  }
}

export type RecordSyncOptions = {
  backfill?: boolean
  local?: Database
  now?: () => string
  identity?: { id: string; name: string }
  projectSpaces?: Record<string, string>
  client?: {
    whoami: RecordApiClient['whoami']
    sync: NonNullable<RecordApiClient['sync']>
    ensureSpaceBuiltIns?: RecordApiClient['ensureSpaceBuiltIns']
  }
}
