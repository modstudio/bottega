// concern: record-sync
/** Chooses one size-bounded batch and identifies payloads that cannot be sent. */

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

export function oversizedRecordSyncReason(payloadBytes: number, payloadLimit: number): string {
  return `record sync payload is ${payloadBytes} bytes, exceeding the ${payloadLimit} byte limit; retire its row with \`orch record outbox retire <row-id> --reason <text>\`, then retry \`orch sync\``
}

export function planRecordSyncBatch(input: {
  rows: RecordSyncBatchCandidate[]
  emptyRequestBytes: number
  payloadLimit: number
  requestLimit: number
  countLimit: number
}): { quarantine: OversizedRecordSyncRow[]; send: RecordSyncBatchCandidate[] } {
  const quarantine: OversizedRecordSyncRow[] = []
  const send: RecordSyncBatchCandidate[] = []
  let requestBytes = input.emptyRequestBytes
  for (const row of input.rows) {
    if (row.payloadBytes > input.payloadLimit) {
      quarantine.push({
        id: row.id,
        kind: row.kind,
        payloadBytes: row.payloadBytes,
        reason: oversizedRecordSyncReason(row.payloadBytes, input.payloadLimit),
      })
      continue
    }
    if (send.length === input.countLimit) break
    const separatorBytes = send.length ? 1 : 0
    if (requestBytes + separatorBytes + row.serializedBytes > input.requestLimit) break
    send.push(row)
    requestBytes += separatorBytes + row.serializedBytes
  }
  return { quarantine, send }
}
