// concern: record-write-decision
/** Decides shared-state write authority from plain install facts. */

export type RecordWriteDecision = 'hosted' | 'local-authoritative' | 'refused'

export function decideRecordWrite(input: {
  recordApiConfigured: boolean
  installBound: boolean
  boundOrigin: string | null
  resolvedOrigin: string
}): RecordWriteDecision {
  if (input.recordApiConfigured) return 'hosted'
  if (!input.installBound) return 'local-authoritative'
  return input.boundOrigin === null || input.boundOrigin === input.resolvedOrigin
    ? 'hosted'
    : 'refused'
}
