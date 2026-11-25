// concern: chain database guard
/** Refuses recreation when a chain's retained database would collide with the new tree. */

import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { readSnapshot } from '../recipe/tracked-recipe.ts'

type HeldDatabaseClaim = {
  allocation_key: string
  run_record_id: string
  state: 'claimed' | 'retained'
}

function recipeReusesDatabase(rootId: string): boolean {
  const databases = readSnapshot(rootId).snapshot?.recipe.allocate?.databases ?? {}
  return Object.values(databases).some((database) => database.provision?.reuse === true)
}

export function dirtyChainTreePath(rootId: string): string | null {
  const rows = db()
    .query(
      `SELECT worktree FROM run
        WHERE (record_id=? OR parent_run_record_id=?)
          AND agent <> '(pending)' AND worktree IS NOT NULL
        ORDER BY turn DESC,number DESC`,
    )
    .all(rootId, rootId) as { worktree: string }[]
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.worktree)) continue
    seen.add(row.worktree)
    if (
      existsSync(row.worktree) &&
      git(['status', '--porcelain', '--untracked-files=all'], row.worktree) !== ''
    ) {
      return row.worktree
    }
  }
  return null
}

export function refuseMissingChainTreeDatabase(
  rootId: string,
  options: { dirtyTreePath?: string | null; retryCommand?: string } = {},
): void {
  if (recipeReusesDatabase(rootId)) return
  const claims = db()
    .query(
      `SELECT allocation_key,run_record_id,state FROM resource_claim
        WHERE root_run_record_id=? AND kind='database' AND state IN ('claimed','retained')
        ORDER BY claimed_at,record_id`,
    )
    .all(rootId) as HeldDatabaseClaim[]
  if (!claims.length) return
  const details = claims
    .map((claim) => {
      const separator = claim.allocation_key.indexOf(':')
      const databaseName =
        separator >= 0 ? claim.allocation_key.slice(separator + 1) : claim.allocation_key
      return `${databaseName} (owning turn ${claim.run_record_id}, resource_claim state ${claim.state})`
    })
    .join(', ')
  if (options.dirtyTreePath) {
    throw new Error(
      `run ${rootId} cannot recreate its tree because it still holds database ${details}; ` +
        `commit or discard the uncommitted changes in ${options.dirtyTreePath}, then retry ` +
        `${options.retryCommand ?? `${PLATFORM_SLUG} run continue ${rootId}`}`,
    )
  }
  throw new Error(
    `run ${rootId} cannot recreate its missing tree because it still holds database ${details}; ` +
      `this is leaked state to report to the architect (note ${PLATFORM_SLUG}#3141: no verb releases a ` +
      'chain database while keeping its branch)',
  )
}
