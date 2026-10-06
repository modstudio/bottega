// concern: record-write-decision
/** Decides shared-state write authority from plain install facts. */

export type RecordWriteDecision = 'hosted' | 'local-authoritative' | 'refused'

export function decideRecordWrite(input: {
  recordApiUrlSet: boolean
  installBound: boolean
}): RecordWriteDecision {
  if (input.recordApiUrlSet) return 'hosted'
  return input.installBound ? 'refused' : 'local-authoritative'
}
