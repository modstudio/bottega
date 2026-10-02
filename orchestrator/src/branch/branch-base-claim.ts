// concern: branch-base-claim
/** Knows whether the latest turn of a chain still claims its root's named base branch. */

import { db } from '../database/db.ts'
import type { Project } from '../project/projects.ts'

export type LiveBaseClaim = { run_id: number; status: string }

/** The latest turn of a chain whose root names this branch as its base. */
export function liveBaseClaim(project: Project, branch: string): LiveBaseClaim | null {
  return db()
    .query(
      `SELECT latest.id run_id,latest.status
         FROM run root
         JOIN run latest ON latest.id=(
           SELECT member.id FROM run member
            WHERE member.id=root.id OR member.parent_run_id=root.id
            ORDER BY member.turn DESC,member.id DESC LIMIT 1
         )
        WHERE root.parent_run_id IS NULL
          AND CASE WHEN root.launch_base LIKE 'refs/heads/%'
                   THEN substr(root.launch_base,12) ELSE root.launch_base END=?
          AND (root.project_id=? OR (root.project_id IS NULL AND root.repo=?))
          AND latest.status IN ('reserved','attached','running','asking')
        ORDER BY latest.id DESC LIMIT 1`,
    )
    .get(branch, project.id, project.name) as LiveBaseClaim | null
}
