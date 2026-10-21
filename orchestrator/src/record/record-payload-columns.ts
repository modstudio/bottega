// concern: record-payload-columns
/** Classifies hosted-record payload column compatibility. */
import { OutboxRowError } from './outbox-failure.ts'
import { HostedApiUpgradeRequiredError } from './outbox-held-contract.ts'

export function assertRecordPayloadColumns(
  kind: string,
  payload: Record<string, unknown>,
  columns: readonly string[],
): void {
  const keys = Object.keys(payload).sort()
  const expected = [...columns].sort()
  const expectedSet = new Set(expected)
  const keySet = new Set(keys)
  const extra = keys.filter((key) => !expectedSet.has(key))
  const missing = expected.filter((column) => !keySet.has(column))
  if (extra.length && !missing.length) throw new HostedApiUpgradeRequiredError(kind, extra)
  if (extra.length || missing.length) {
    throw new OutboxRowError(`${kind} outbox payload has an unexpected column set`, 'payload')
  }
}
