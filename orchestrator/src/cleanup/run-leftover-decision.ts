// concern: scheduled run-store leftover cleanup policy

import { RUN_LEFTOVER_MAX_AGE_DAYS } from '../run/run-artifact-limits.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { decideUnjudgedRunRemedy, type UnjudgedRunRemedy } from './unjudged-run-remedy.ts'

const RUN_LEFTOVER_MAX_AGE_MS = RUN_LEFTOVER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

export type RunLeftoverKind = 'scratch' | 'sandbox' | 'isolate' | 'artifacts' | 'orphan'

export type RunLeftoverFacts = {
  kind: RunLeftoverKind
  runStatus: string | null
  finishedAt: number | null
  judged: boolean
  failureKind: string | null
  newestEntryAt: number | null
  clock: number
}

export type RunLeftoverKeepReason =
  | 'live'
  | 'recently finished'
  | 'finish time unknown'
  | 'no recorded verdict'
  | 'orphan age unknown'
  | 'young orphan'
  | 'sandbox held'

export type RunLeftoverDecision =
  | { action: 'remove'; reason: string }
  | {
      action: 'keep'
      reason: RunLeftoverKeepReason
      status?: string
      detail?: string
      remedy?: UnjudgedRunRemedy
    }

/** Decide one directory without knowing the filesystem, database, or clock source. */
export function decideRunLeftover(facts: RunLeftoverFacts): RunLeftoverDecision {
  const cutoff = facts.clock - RUN_LEFTOVER_MAX_AGE_MS
  if (facts.kind === 'orphan') {
    if (facts.newestEntryAt === null) return { action: 'keep', reason: 'orphan age unknown' }
    return facts.newestEntryAt < cutoff
      ? { action: 'remove', reason: 'orphan is older than the run leftover age cap' }
      : { action: 'keep', reason: 'young orphan' }
  }
  if (facts.runStatus === null || !TERMINAL_RUN_STATUS_SET.has(facts.runStatus))
    return { action: 'keep', reason: 'live', status: facts.runStatus ?? 'unknown' }
  if (facts.finishedAt === null) return { action: 'keep', reason: 'finish time unknown' }
  if (facts.finishedAt >= cutoff) return { action: 'keep', reason: 'recently finished' }
  if (facts.kind === 'artifacts' && !facts.judged)
    return {
      action: 'keep',
      reason: 'no recorded verdict',
      remedy: decideUnjudgedRunRemedy(facts.failureKind),
    }
  return { action: 'remove', reason: 'terminal run is older than the run leftover age cap' }
}
