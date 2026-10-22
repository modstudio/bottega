// concern: database migration compatibility
/** Decides whether a process may keep its open store handle after the journal advances. */

export type InFlightMigrationCompatibility = 'additive' | 'incompatible'

export type MigrationJournalEntry = {
  idx: number
  when: number
  tag: string
  compatibility?: InFlightMigrationCompatibility
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
    reason: `store migrated to version ${input.storeVersion} while this run was in flight; re-dispatch it`,
  }
}

export function validatedMigrationJournalEntries(
  entries: MigrationJournalEntry[],
): MigrationJournalEntry[] {
  for (const entry of entries) {
    if (entry.compatibility !== undefined && entry.compatibility !== 'additive') {
      throw new Error(`invalid migration compatibility for ${entry.tag}`)
    }
  }
  return entries
}

/** An unmarked or unavailable entry makes the whole in-flight range incompatible. */
export function inFlightMigrationCompatibility(
  entries: Array<{ idx: number; when: number; tag: string }>,
  processJournalVersion: number,
  storeVersion: number,
): InFlightMigrationCompatibility {
  if (storeVersion <= processJournalVersion) return 'incompatible'
  let changed: MigrationJournalEntry[]
  try {
    changed = validatedMigrationJournalEntries(
      entries.slice(processJournalVersion, storeVersion) as MigrationJournalEntry[],
    )
  } catch {
    return 'incompatible'
  }
  if (
    changed.length !== storeVersion - processJournalVersion ||
    changed.some((entry) => entry.compatibility !== 'additive')
  ) {
    return 'incompatible'
  }
  return 'additive'
}
