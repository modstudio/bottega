// concern: migration-backfill-compatibility
/** Selects backfills that remain valid against the store's current schema generation. */
import type { Database } from 'bun:sqlite'
import {
  LENS_PROFILE_PIN_CONTRACT_MIGRATION,
  selectionIntegerVersionExists,
} from './lens-profile-pin-contract-preflight.ts'
import type { MigrationJournalEntry } from './migration-compatibility.ts'

export const BACKFILL_SCHEMA_BOUNDARIES = new Set([
  '0117_project_uuid_key',
  LENS_PROFILE_PIN_CONTRACT_MIGRATION,
])
const INTEGER_PROJECT_BACKFILLS = new Set([
  '0006_project_id_backfill',
  '0010_landing_queue',
  '0116_release_project_identity',
])

export function compatibleBackfillEntries(
  database: Database,
  entries: MigrationJournalEntry[],
): MigrationJournalEntry[] {
  const legacy = database
    .query<{ project: number; run: number; review: number; cursor: number }, []>(`SELECT
      (SELECT count(*) FROM pragma_table_info('project') WHERE name='id') project,
      (SELECT count(*) FROM pragma_table_info('run') WHERE name='id') run,
      (SELECT count(*) FROM pragma_table_info('review') WHERE name='id') review,
      (SELECT count(*) FROM pragma_table_info('workflow_cursor') WHERE name='id') cursor`)
    .get()!
  if (legacy.project > 0)
    return entries.filter((entry) => !BACKFILL_SCHEMA_BOUNDARIES.has(entry.tag))
  const selectionHasIntegerVersion = selectionIntegerVersionExists(database)
  return entries.filter(
    (entry) =>
      !INTEGER_PROJECT_BACKFILLS.has(entry.tag) &&
      (legacy.run > 0 || entry.tag !== '0117_project_uuid_key') &&
      (legacy.review > 0 || entry.tag !== '0124_run_uuid_key') &&
      (legacy.cursor > 0 || entry.tag !== '0056_workflow_questions') &&
      (selectionHasIntegerVersion || entry.tag !== '0190_lens_profile_selected_version_id'),
  )
}
