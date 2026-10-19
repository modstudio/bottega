// concern: branches
/** Settles a creation-time branch claim only after cleanup proves the minted ref is gone. */

import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { type GitRefObservation, observeGitRef } from '../git/git-environment.ts'
import { settleClaims } from '../resources/resource-claims.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

export function settleCreateTimeBranchCleanup(
  worktree: Worktree,
  runId: string,
  options: {
    database?: Database
    observeRef?: (repository: string, ref: string) => GitRefObservation
  } = {},
): void {
  if (!worktree.mintedBranch) return
  const database = options.database ?? db()
  const ref = `refs/heads/${worktree.mintedBranch}`
  if ((options.observeRef ?? observeGitRef)(worktree.repoRoot, ref).outcome !== 'absent') return
  const run = database
    .query('SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?')
    .get(runId) as { root_id: string } | null
  if (!run) return
  const settle = () =>
    settleClaims(database, {
      rootRunId: run.root_id,
      kind: 'branch',
      state: 'released',
      settledAt: nowIso(),
      detail: `deleted ${ref}`,
      allocationKey: ref,
    })
  if (options.database) settle()
  else writeTransaction(settle)
}
