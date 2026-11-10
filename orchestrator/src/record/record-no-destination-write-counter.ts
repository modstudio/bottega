// concern: record-no-destination-write-counter
/** Keeps process-local destination-less write measurements and emits best-effort evidence logs. */

import type {
  NoDestinationWriteReport,
  NoDestinationWriteReportRow,
} from './record-no-destination-write-contract.ts'
import type { NoDestinationWrite } from './record-no-destination-write-decision.ts'

const processStartedAt = new Date().toISOString()
const counts = new Map<string, NoDestinationWriteReportRow>()

export function noDestinationWriteCounter(
  input: { record: NoDestinationWrite } | { read: readonly string[] },
): NoDestinationWriteReport | undefined {
  if ('read' in input) {
    const spaces = new Set(input.read)
    return {
      processStartedAt,
      counts: [...counts.values()].filter((row) => spaces.has(row.spaceId)),
    }
  }
  const row = input.record
  const key = JSON.stringify([row.spaceId, row.route, row.cause])
  const existing = counts.get(key)
  counts.set(
    key,
    existing ? { ...existing, occurrences: existing.occurrences + 1 } : { ...row, occurrences: 1 },
  )
  queueMicrotask(() => {
    try {
      console.info('record-write no-destination', JSON.stringify(row))
    } catch {}
  })
}
