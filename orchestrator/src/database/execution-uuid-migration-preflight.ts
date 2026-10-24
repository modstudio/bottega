import type { Database } from 'bun:sqlite'

/** Refuse the UUID-key rebuild when a legacy check has no gate to relink. */
export function gateCheckExecutionOrphanCounts(database: Database): string[] {
  const count = (
    database
      .query(
        `SELECT COUNT(*) n FROM check_execution child
         WHERE NOT EXISTS (
           SELECT 1 FROM gate_execution parent WHERE parent.id=child.gate_execution_id
         )`,
      )
      .get() as { n: number }
  ).n
  return count ? [`check_execution.gate_execution_record_id=${count}`] : []
}

/** Refuse the UUID-key rebuild when a legacy monitor condition has no invocation to relink. */
export function monitorReleaseClaimOrphanCounts(database: Database): string[] {
  const count = (
    database
      .query(
        `SELECT COUNT(*) n FROM monitor_condition child
         WHERE NOT EXISTS (
           SELECT 1 FROM monitor_invocation parent WHERE parent.id=child.invocation_id
         )`,
      )
      .get() as { n: number }
  ).n
  return count ? [`monitor_condition.invocation_record_id=${count}`] : []
}
