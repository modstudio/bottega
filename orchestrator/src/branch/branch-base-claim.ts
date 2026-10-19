// concern: branch-base-claim
/** Knows whether the latest turn of a chain still claims its root's named base branch. */

import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'

export type LiveBaseClaim = { run_record_id: string; status: string }

/** The latest turn of a chain whose root names this branch as its base. */
export function liveBaseClaim(project: Project, branch: string): LiveBaseClaim | null {
  return db()
    .query(
      `SELECT latest.record_id run_record_id,latest.status
         FROM run root
         JOIN run latest ON latest.record_id=(
           SELECT member.record_id FROM run member
            WHERE member.record_id=root.record_id OR member.parent_run_record_id=root.record_id
            ORDER BY member.turn DESC,member.number DESC LIMIT 1
         )
        WHERE root.parent_run_record_id IS NULL
          AND CASE WHEN root.launch_base LIKE 'refs/heads/%'
                   THEN substr(root.launch_base,12) ELSE root.launch_base END=?
          AND root.project_record_id=?
          AND latest.status IN ('reserved','attached','running','asking')
        ORDER BY latest.number DESC LIMIT 1`,
    )
    .get(branch, project.recordId) as LiveBaseClaim | null
}
