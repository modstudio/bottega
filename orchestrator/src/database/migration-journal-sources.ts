// concern: machine-local migration journal sources
/** Names every local store journal migrated by the main checkout's binary. */

export const ORCHESTRATOR_MIGRATION_JOURNAL_SOURCE = {
  store: 'orchestrator',
  path: 'orchestrator/migrations/meta/_journal.json',
} as const
