// concern: run-claim-inheritance
/** Reads the root facts a retained turn inherits while it is claimed. */

import { db } from '../database/db.ts'

export function inheritedRunFacts(parent: number): {
  launch_cwd: string | null
  launch_seed: string | null
  launch_key: string | null
  launch_base: string | null
  no_failover: number
  task_record_id: string | null
  branch: string | null
} {
  return db()
    .query(
      `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover, task_record_id, branch
         FROM run WHERE id=?`,
    )
    .get(parent) as ReturnType<typeof inheritedRunFacts>
}
