import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

/** Refuse a UUID-key rebuild that would drop or merge an invalid identity. */
function agentPortBaselineIdentityConflicts(database: Database): string[] {
  const conflicts: string[] = []
  const rows = database
    .query(
      `SELECT 'agent' table_name, SUM(record_id IS NULL) nulls,
              COUNT(record_id) - COUNT(DISTINCT record_id) duplicates FROM agent
       UNION ALL
       SELECT 'port_baseline' table_name, SUM(record_id IS NULL) nulls,
              COUNT(record_id) - COUNT(DISTINCT record_id) duplicates FROM port_baseline`,
    )
    .all() as { table_name: string; nulls: number | null; duplicates: number }[]
  for (const row of rows) {
    if (row.nulls) conflicts.push(`${row.table_name}.record_id NULL=${row.nulls}`)
    if (row.duplicates) conflicts.push(`${row.table_name}.record_id duplicate=${row.duplicates}`)
  }
  return conflicts
}

/** Run the identity preflight and name the repair before any rebuild starts. */
export function assertAgentPortBaselineIdentities(database: Database): void {
  const conflicts = agentPortBaselineIdentityConflicts(database)
  if (!conflicts.length) return
  throw new Error(
    `refusing agent/port baseline UUID-key migration: rows have invalid record ids (${conflicts.join(', ')})\n` +
      `cleared by: repair the named record ids, then run \`${PLATFORM_SLUG} database migrate\``,
  )
}
