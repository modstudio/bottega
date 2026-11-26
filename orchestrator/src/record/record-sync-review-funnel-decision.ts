// concern: record-sync
/** Withholds review history that is already represented by its own hosted records. */
import { createHash } from 'node:crypto'
import type { RecordPayload } from './record-sync-contract.ts'

const WITHHELD_HISTORY_PATHS = ['facts.branchReviews', 'facts.rounds'] as const

type WithheldHistoryMarker = {
  withheld: true
  count: number
  digest: string
}

function historyMarker(history: unknown[]): WithheldHistoryMarker {
  return {
    withheld: true,
    count: history.length,
    digest: createHash('sha256').update(JSON.stringify(history)).digest('hex'),
  }
}

/** Returns the same object when the decision has no history arrays to withhold. */
export function withholdReviewFunnelDecisionHistory(payload: RecordPayload): RecordPayload {
  const facts = payload.facts
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return payload

  const branchReviews = Reflect.get(facts, 'branchReviews')
  const rounds = Reflect.get(facts, 'rounds')
  const withheld = [
    ...(Array.isArray(branchReviews) ? [WITHHELD_HISTORY_PATHS[0]] : []),
    ...(Array.isArray(rounds) ? [WITHHELD_HISTORY_PATHS[1]] : []),
  ]
  if (withheld.length === 0) return payload

  const existing = Array.isArray(payload.withheldFields)
    ? payload.withheldFields.filter((path): path is string => typeof path === 'string')
    : []
  return {
    ...payload,
    facts: {
      ...facts,
      ...(Array.isArray(branchReviews) ? { branchReviews: historyMarker(branchReviews) } : {}),
      ...(Array.isArray(rounds) ? { rounds: historyMarker(rounds) } : {}),
    },
    withheldFields: [...new Set([...existing, ...withheld])],
  }
}
