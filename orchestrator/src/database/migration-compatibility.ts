// concern: database migration compatibility
/** Decides whether a process may keep its open store handle after the journal advances. */

export const CONNECTION_SCHEMA_INVARIANT = 'A process writes only the schema version it opened.'

export type InFlightMigrationCompatibility = 'additive' | 'incompatible'

export type MigrationJournalEntry = {
  idx: number
  when: number
  tag: string
  compatibility?: 'additive'
}

export type InFlightMigrationDecision =
  | { action: 'keep-going' }
  | { action: 'fail'; reason: string }

export function decideInFlightMigration(input: {
  processJournalVersion: number
  storeVersion: number
  migrationCompatibility: InFlightMigrationCompatibility
}): InFlightMigrationDecision {
  if (input.storeVersion === input.processJournalVersion) return { action: 'keep-going' }
  if (
    input.storeVersion > input.processJournalVersion &&
    input.migrationCompatibility === 'additive'
  ) {
    return { action: 'keep-going' }
  }
  return {
    action: 'fail',
    reason:
      `store migrated from version ${input.processJournalVersion} to ${input.storeVersion} past this process's version; ` +
      `restart this process, and re-dispatch any run it was coordinating`,
  }
}

export function validatedMigrationJournalEntries(entries: unknown[]): MigrationJournalEntry[] {
  for (const [position, value] of entries.entries()) {
    const entry = value as Partial<MigrationJournalEntry>
    if (entry.idx !== position) {
      throw new Error(
        `invalid migration journal index for ${entry.tag ?? `entry ${position}`}: expected ${position}, got ${String(entry.idx)}`,
      )
    }
    if (entry.compatibility !== undefined && entry.compatibility !== 'additive') {
      throw new Error(`invalid migration compatibility for ${entry.tag}`)
    }
  }
  return entries as MigrationJournalEntry[]
}

/** An unmarked or unavailable entry makes the whole in-flight range incompatible. */
export function inFlightMigrationCompatibility(
  entries: MigrationJournalEntry[],
  processJournalVersion: number,
  storeVersion: number,
): InFlightMigrationCompatibility {
  if (storeVersion <= processJournalVersion) return 'incompatible'
  const changed = entries.slice(processJournalVersion, storeVersion)
  if (
    changed.length !== storeVersion - processJournalVersion ||
    changed.some((entry) => entry.compatibility !== 'additive')
  ) {
    return 'incompatible'
  }
  return 'additive'
}
