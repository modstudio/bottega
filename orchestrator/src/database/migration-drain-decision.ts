// concern: database migration drain decision
/** Decides whether an incoming migration range may move under orchestrator runs. */

import type { MigrationJournalEntry } from './migration-compatibility.ts'
import { inFlightMigrationCompatibility } from './migration-compatibility.ts'

export type MigrationDrainDecision =
  | { action: 'apply-now' }
  | { action: 'fence'; migration: string }

export function decideMigrationDrain(input: {
  journal: MigrationJournalEntry[]
  storeVersion: number
}): MigrationDrainDecision {
  const incomingVersion = input.journal.length
  if (incomingVersion <= input.storeVersion) return { action: 'apply-now' }
  if (
    inFlightMigrationCompatibility(input.journal, input.storeVersion, incomingVersion) ===
    'additive'
  ) {
    return { action: 'apply-now' }
  }
  return { action: 'fence', migration: input.journal[input.storeVersion]!.tag }
}
