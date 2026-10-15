// concern: record-sync
/** Chooses one size-bounded batch and identifies payloads that cannot be sent. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
export type RecordSyncBatchCandidate = {
  id: number
  kind: string
  payloadBytes: number
  serializedBytes: number
}

export type OversizedRecordSyncRow = {
  id: number
  kind: string
  payloadBytes: number
  reason: string
}

type RecordSyncBatchStep =
  | { disposition: 'send'; requestBytes: number }
  | { disposition: 'quarantine'; row: OversizedRecordSyncRow }
  | { disposition: 'stop' }

function oversizedRecordSyncReason(payloadBytes: number, payloadLimit: number): string {
  return `record sync payload is ${payloadBytes} bytes, exceeding the ${payloadLimit} byte limit; retire its row with \`${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text>\`, then retry \`${PLATFORM_SLUG} record sync\``
}

function oversizedRecordSyncRequestReason(
  serializedBytes: number,
  requestBytes: number,
  requestLimit: number,
): string {
  return `record sync serialized row is ${serializedBytes} bytes and requires a ${requestBytes} byte request, exceeding the ${requestLimit} byte client request budget; retire its row with \`${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text>\`, then retry \`${PLATFORM_SLUG} record sync\``
}

/** Classifies one row against the current batch without reading or parsing any stored data. */
function considerRecordSyncCandidate(input: {
  row: RecordSyncBatchCandidate
  requestBytes: number
  sendCount: number
  payloadLimit: number
  requestLimit: number
  countLimit: number
}): RecordSyncBatchStep {
  const { row } = input
  if (row.payloadBytes > input.payloadLimit) {
    return {
      disposition: 'quarantine',
      row: {
        id: row.id,
        kind: row.kind,
        payloadBytes: row.payloadBytes,
        reason: oversizedRecordSyncReason(row.payloadBytes, input.payloadLimit),
      },
    }
  }
  if (input.sendCount === input.countLimit) return { disposition: 'stop' }
  // A row after the first also costs the comma that separates it from the row before.
  const nextRequestBytes =
    input.requestBytes + (input.sendCount === 0 ? 0 : 1) + row.serializedBytes
  if (nextRequestBytes > input.requestLimit) {
    if (input.sendCount > 0) return { disposition: 'stop' }
    return {
      disposition: 'quarantine',
      row: {
        id: row.id,
        kind: row.kind,
        payloadBytes: row.payloadBytes,
        reason: oversizedRecordSyncRequestReason(
          row.serializedBytes,
          nextRequestBytes,
          input.requestLimit,
        ),
      },
    }
  }
  return { disposition: 'send', requestBytes: nextRequestBytes }
}

export function planRecordSyncBatch(input: {
  rows: RecordSyncBatchCandidate[]
  emptyRequestBytes: number
  initialSendCount?: number
  payloadLimit: number
  requestLimit: number
  countLimit: number
}): {
  quarantine: OversizedRecordSyncRow[]
  send: RecordSyncBatchCandidate[]
  requestBytes: number
} {
  // Unless a non-empty batch has reached a boundary, every supplied row is classified as
  // either sent or quarantined. In particular, a row that cannot fit by itself is quarantined.
  const quarantine: OversizedRecordSyncRow[] = []
  const send: RecordSyncBatchCandidate[] = []
  let requestBytes = input.emptyRequestBytes
  for (const row of input.rows) {
    const step = considerRecordSyncCandidate({
      row,
      requestBytes,
      sendCount: (input.initialSendCount ?? 0) + send.length,
      payloadLimit: input.payloadLimit,
      requestLimit: input.requestLimit,
      countLimit: input.countLimit,
    })
    if (step.disposition === 'stop') break
    if (step.disposition === 'quarantine') {
      quarantine.push(step.row)
      continue
    }
    send.push(row)
    requestBytes = step.requestBytes
  }
  return { quarantine, send, requestBytes }
}
