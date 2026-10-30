// concern: record-sync-contract
/** Plain transport contract for one ordered hosted-record evidence batch. */

export const RECORD_SYNC_BATCH_SIZE = 100
export const RECORD_SYNC_MAX_PAYLOAD_BYTES = 1024 * 1024
export const RECORD_SYNC_CLIENT_MAX_REQUEST_BYTES = 4 * 1024 * 1024
export const RECORD_SYNC_MAX_REQUEST_BYTES = 8 * 1024 * 1024

export type RecordPayload = Record<string, unknown>
export type RecordPrincipal = { userId: string; spaceId: string }

export type RecordSyncRequestRow = {
  id: number
  kind: string
  payload: string
  spaceHint: string | null
}

export type RecordSyncRequest = {
  machine: {
    id: string
    shortName?: string
    displayName?: string
    name?: string
    seenAt: string
  }
  rows: RecordSyncRequestRow[]
}

export type RecordSyncRowResult =
  | { id: number; status: 'synced' }
  | { id: number; status: 'quarantined'; reason: string }
  | { id: number; status: 'deferred'; reason: string; spaceId: string }
  | { id: number; status: 'held'; reason: string }

export type RecordSyncResponse = { results: RecordSyncRowResult[] }
