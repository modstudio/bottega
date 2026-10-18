// concern: scheduled run-store leftover cleanup policy

import { RUN_LEFTOVER_MAX_AGE_DAYS } from '../run/run-artifact-limits.ts'

const TERMINAL_RUN_STATUSES = new Set(['ok', 'failed', 'stale', 'stopped'])
const RUN_LEFTOVER_MAX_AGE_MS = RUN_LEFTOVER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

export type RunLeftoverKind = 'scratch' | 'sandbox' | 'isolate' | 'artifacts' | 'orphan'

export type RunLeftoverFacts = {
  kind: RunLeftoverKind
  runStatus: string | null
  finishedAt: number | null
  judged: boolean
  newestEntryAt: number | null
  clock: number
}

export type RunLeftoverDecision =
  | { action: 'remove'; reason: string }
  | { action: 'keep'; reason: string; remedy?: 'score' }

/** Decide one directory without knowing the filesystem, database, or clock source. */
export function decideRunLeftover(facts: RunLeftoverFacts): RunLeftoverDecision {
  const cutoff = facts.clock - RUN_LEFTOVER_MAX_AGE_MS
  if (facts.kind === 'orphan') {
    if (facts.newestEntryAt === null)
      return { action: 'keep', reason: 'orphan age could not be established' }
    return facts.newestEntryAt < cutoff
      ? { action: 'remove', reason: 'orphan is older than the run leftover age cap' }
      : { action: 'keep', reason: 'orphan is not older than the run leftover age cap' }
  }
  if (facts.runStatus === null || !TERMINAL_RUN_STATUSES.has(facts.runStatus))
    return { action: 'keep', reason: `run is live (${facts.runStatus ?? 'unknown'})` }
  if (facts.finishedAt === null)
    return { action: 'keep', reason: 'run finish time could not be established' }
  if (facts.finishedAt >= cutoff)
    return { action: 'keep', reason: 'run is not older than the run leftover age cap' }
  if (facts.kind === 'artifacts' && !facts.judged)
    return { action: 'keep', reason: 'run has no recorded verdict', remedy: 'score' }
  return { action: 'remove', reason: 'terminal run is older than the run leftover age cap' }
}
