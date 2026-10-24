// concern: database migration drain decision
/** Decides whether an incoming migration range may move under orchestrator runs. */

import type { MigrationInFlightRun } from '../run/migration-in-flight-runs.ts'
import type { MigrationJournalEntry } from './migration-compatibility.ts'
import { inFlightMigrationCompatibility } from './migration-compatibility.ts'

export type MigrationDrainDecision =
  | { action: 'apply-now' }
  | { action: 'drain'; migration: string }
  | { action: 'refuse'; reason: 'drain-impossible' | 'wait-bound-reached' }

export function decideMigrationDrain(input: {
  journal: MigrationJournalEntry[]
  storeVersion: number
  runs: MigrationInFlightRun[]
  canDrain: boolean
  waitBoundReached: boolean
}): MigrationDrainDecision {
  const incomingVersion = input.journal.length
  if (incomingVersion <= input.storeVersion) return { action: 'apply-now' }
  if (
    inFlightMigrationCompatibility(input.journal, input.storeVersion, incomingVersion) ===
    'additive'
  ) {
    return { action: 'apply-now' }
  }
  if (input.runs.length === 0) return { action: 'apply-now' }
  if (input.waitBoundReached) return { action: 'refuse', reason: 'wait-bound-reached' }
  if (!input.canDrain) return { action: 'refuse', reason: 'drain-impossible' }
  return { action: 'drain', migration: input.journal[input.storeVersion]!.tag }
}
