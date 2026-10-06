// concern: record-write-authority
/** Applies shared-state write authority at the hosted-record boundary. */

import { readRecordInstallBinding, rememberHostedRecord } from './install-binding.ts'
import { decideRecordWrite, type RecordWriteDecision } from './record-write-decision.ts'

export const BOUND_RECORD_WRITE_REFUSAL =
  'this install is bound to a hosted record, but ORCH_RECORD_API_URL is not set in this environment\n' +
  'cleared by: orch record doctor'

export function currentRecordWriteDecision(): RecordWriteDecision {
  return decideRecordWrite({
    recordApiUrlSet: Boolean(process.env.ORCH_RECORD_API_URL?.trim()),
    installBound: readRecordInstallBinding().bound,
  })
}

export async function applyRecordWriteAuthority<T>(actions: {
  local(): T | Promise<T>
  hosted(): T | Promise<T>
}): Promise<T> {
  const decision = currentRecordWriteDecision()
  if (decision === 'refused') throw new Error(BOUND_RECORD_WRITE_REFUSAL)
  if (decision === 'local-authoritative') return actions.local()
  const result = await actions.hosted()
  rememberHostedRecord()
  return result
}

export function requireHostedRecord(command: string): void {
  const decision = currentRecordWriteDecision()
  if (decision === 'refused') throw new Error(BOUND_RECORD_WRITE_REFUSAL)
  if (decision === 'local-authoritative') {
    throw new Error(
      `no hosted record is configured for this install; set ORCH_RECORD_API_URL before running \`${command}\``,
    )
  }
}
