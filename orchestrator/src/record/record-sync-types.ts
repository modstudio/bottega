// concern: record-sync
/** Plain local types for hosted-record synchronization. */
import type { Database } from 'bun:sqlite'
import type { SQL } from 'bun'
import type { RecordSpaceMembership } from '../../../shared/record-space-membership.ts'
import type { ReviewRecordBackfillResult } from '../review/review-outbox.ts'
import type { RunRecordBackfillResult } from '../run/run-outbox.ts'
import type { LandingEvidenceBackfillResult } from './landing-outbox.ts'
import type { QuarantinedOutboxRow } from './outbox-quarantine.ts'

export type OutboxRow = { id: number; kind: string; record_id: string; payload: string }
export type Payload = Record<string, unknown>
export type BlockedOutboxRow = {
  id: number
  kind: string
  parentRecordId: string
  reason?: string
}

export type RecordSyncResult = {
  pushed: number
  failed: number
  pending: number
  configured: boolean
  quarantined: QuarantinedOutboxRow[]
  blocked: BlockedOutboxRow[]
  readOnlyDeferred?: { spaceId: string; rows: number }[]
  backfill?: RunRecordBackfillResult & {
    scores: number
    reviews: ReviewRecordBackfillResult
    landingEvidence: LandingEvidenceBackfillResult
    questions: { minted: number; enqueued: number }
  }
}

export type RecordSyncOptions = {
  backfill?: boolean
  recordUrl?: string
  local?: Database
  openSql?: (url: string) => SQL
  now?: () => string
  identity?: { id: string; name: string }
  principal?: { userId: string; spaceId: string }
  memberships?: RecordSpaceMembership[]
  projectSpaces?: Record<string, string>
}
