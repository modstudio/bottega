// concern: review lineage store adapter
/** Reads branch-mint facts and delegates lineage policy to the pure review decision. */
import type { Database } from 'bun:sqlite'
import { branchReviewLineage } from './review-lineage.ts'

/** Read one project's branch-mint facts and resolve the requested branch's review lineage. */
export function reviewLineage(database: Database, project: string, branch: string): string[] {
  const facts = database
    .query<
      {
        minted_branch: string
        launch_base: string | null
        launch_key: string | null
        head_commit: string | null
      },
      [string]
    >(
      `SELECT minted_branch,launch_base,launch_key,head_commit FROM run
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND minted_branch IS NOT NULL
        ORDER BY number`,
    )
    .all(project)
    .map((row) => ({
      mintedBranch: row.minted_branch,
      launchBase: row.launch_base,
      launchKey: row.launch_key,
      headCommit: row.head_commit,
    }))
  return branchReviewLineage(branch, facts)
}
