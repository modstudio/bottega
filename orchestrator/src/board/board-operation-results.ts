// concern: board-operation-routing
/** Normalizes local and hosted board operation rows into their public result shape. */

import type { BoardWriteDropped } from '../../../shared/board-write-result.ts'
import type { HostedBoardClaim } from '../record/record-board-contract.ts'
import type { ClaimView } from './board-claim-service.ts'

export type BoardPostResult = {
  recordId: string
  number: number | null
  dropped: BoardWriteDropped
  reached: number | null
  warning: string | null
}

export type BoardClaimResult = {
  recordId: string
  project: string
  subject: { kind: 'task' | 'path' | 'resource' | 'queued-task'; value: string }
  holder: string
  holderUserId: string | null
  holderSession: string | null
  note: string | null
  runId: string | null
  run_record_id: string | null
  takenAt: string
  renewedAt: string
  lapsesAt: string
  live: boolean
  closedAt: string | null
  closeReason: string | null
  previousClaimRecordIds: string[]
  supersededByClaimRecordId: string | null
}

const stringId = (value: number | string | null) => (value === null ? null : String(value))

export function claimResult(value: ClaimView | HostedBoardClaim): BoardClaimResult {
  const hosted = !('recordId' in value)
  const recordId = 'recordId' in value ? value.recordId : value.id
  const {
    id: _id,
    previousClaimIds: _previousClaimIds,
    supersededByClaimId: _supersededByClaimId,
    ...fields
  } = value as HostedBoardClaim & ClaimView
  return {
    ...fields,
    holderUserId: hosted ? value.holder : null,
    holderSession: hosted
      ? (value.holderSession ?? null)
      : value.holder === 'operator'
        ? null
        : value.holder,
    recordId,
    runId: stringId(value.runId),
    run_record_id: value.runId,
    previousClaimRecordIds:
      'previousClaimRecordIds' in value ? value.previousClaimRecordIds : value.previousClaimIds,
    supersededByClaimRecordId:
      'supersededByClaimRecordId' in value
        ? value.supersededByClaimRecordId
        : value.supersededByClaimId,
  }
}
