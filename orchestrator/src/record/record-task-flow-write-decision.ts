// concern: hosted task-flow write decisions
/** Pure optimistic-write and idempotent-insert decisions for hosted task-flow intents. */

export type RevisionDecision =
  | { kind: 'write' }
  | { kind: 'retry' }
  | { kind: 'conflict'; currentRevision: number | null }

export function decideRevisionWrite(
  current: { revision: number; lastRequestId: string | null } | null,
  expectedRevision: number,
  requestId: string,
): RevisionDecision {
  if (!current) return { kind: 'conflict', currentRevision: null }
  if (current.revision === expectedRevision) return { kind: 'write' }
  if (current.revision === expectedRevision + 1 && current.lastRequestId === requestId)
    return { kind: 'retry' }
  return { kind: 'conflict', currentRevision: current.revision }
}

export type PreflightDecision =
  | { kind: 'write' }
  | { kind: 'retry' }
  | { kind: 'partial-retry'; index: number }

export function decideRevisionPreflight(
  decisions: readonly ('write' | 'retry')[],
): PreflightDecision {
  if (decisions.every((decision) => decision === 'retry')) return { kind: 'retry' }
  const index = decisions.indexOf('retry')
  return index < 0 ? { kind: 'write' } : { kind: 'partial-retry', index }
}

const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && timestamp.test(value)) return Date.parse(value)
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

export function sameRecordValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}
