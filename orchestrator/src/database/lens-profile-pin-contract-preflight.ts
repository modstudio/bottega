// concern: lens-profile-pin-contract-preflight
/** Refuses the destructive local pin contract until every durable identity is present. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { MigrationJournalEntry } from './migration-compatibility.ts'

export const LENS_PROFILE_PIN_CONTRACT_MIGRATION = '0192_lens_profile_pin_contract'

export function lensProfilePinBackfillEntries(
  entries: MigrationJournalEntry[],
): MigrationJournalEntry[] {
  return entries.filter((entry) =>
    ['0189_lens_profile_current_version_id', '0190_lens_profile_selected_version_id'].includes(
      entry.tag,
    ),
  )
}

export function selectionIntegerVersionExists(database: Database): boolean {
  return (
    (
      database
        .query(
          "SELECT COUNT(*) AS n FROM pragma_table_info('project_lens_profile') WHERE name='selected_version'",
        )
        .get() as { n: number }
    ).n > 0
  )
}

type ContractCounts = {
  unresolvedSelections: number
  unresolvedRevisions: number
  cachedSelections: number
  cachedRevisions: number
  unidentifiedProfiles: number
  cachedProfiles: number
}

function contractCounts(database: Database): ContractCounts {
  return database
    .query<ContractCounts, []>(
      `SELECT
        (SELECT count(*) FROM project_lens_profile
          WHERE selected_version IS NOT NULL AND selected_version_id IS NULL)
          unresolvedSelections,
        (SELECT count(*) FROM project_lens_profile_revision
          WHERE prior_selected_version IS NOT NULL AND prior_selected_version_id IS NULL)
          unresolvedRevisions,
        (SELECT count(*) FROM project_lens_profile
          WHERE space_id IS NOT NULL AND selected_version IS NOT NULL
            AND selected_version_id IS NULL) cachedSelections,
        (SELECT count(*) FROM project_lens_profile_revision
          WHERE space_id IS NOT NULL AND prior_selected_version IS NOT NULL
            AND prior_selected_version_id IS NULL) cachedRevisions,
        (SELECT count(*) FROM lens_profile WHERE current_version_id IS NULL)
          unidentifiedProfiles,
        (SELECT count(*) FROM lens_profile
          WHERE space_id IS NOT NULL AND current_version_id IS NULL) cachedProfiles`,
    )
    .get()!
}

export function assertLensProfilePinContract(database: Database): void {
  const counts = contractCounts(database),
    cachedRows = counts.cachedSelections + counts.cachedRevisions + counts.cachedProfiles,
    localRows =
      counts.unresolvedSelections +
      counts.unresolvedRevisions +
      counts.unidentifiedProfiles -
      cachedRows
  if (cachedRows + localRows === 0) return
  throw new Error(
    `refusing lens profile pin contract: unresolved project_lens_profile=${counts.unresolvedSelections} ` +
      `project_lens_profile_revision=${counts.unresolvedRevisions}; lens_profile.current_version_id NULL=${counts.unidentifiedProfiles}\n` +
      `space-cached rows=${cachedRows}; cleared by: run \`${PLATFORM_SLUG} record pull\`, then retry the migration\n` +
      `local rows=${localRows}; cleared by: re-pin each local selection with \`${PLATFORM_SLUG} project select-profile --version <number>\`, revise or recreate each local profile without a current version id, then retry the migration`,
  )
}
