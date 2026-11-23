// concern: cleanup sweep filesystem orphan claims

import { db } from '../database/db.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { runsClaimingWorktreePath } from '../resources/resource-claims.ts'
import { recordedWorktreeSharerRunIds } from '../resources/resource-ownership.ts'
import { decideFilesystemOrphanUnderLock } from './cleanup-sweep-decisions.ts'

export function rememberedWorktrees(): Set<string> {
  const rows = db().query('SELECT worktree FROM run WHERE worktree IS NOT NULL').all() as {
    worktree: string
  }[]
  return new Set(rows.map((row) => realpathOrSpelled(row.worktree)))
}

function filesystemOrphanClaimants(path: string): string[] {
  return [
    ...new Set([
      ...runsClaimingWorktreePath(db(), path).map((row) => row.record_id),
      ...recordedWorktreeSharerRunIds(db(), path),
    ]),
  ]
}

export function orphanClaimRuling(path: string, sharers: number, lockedAlive: boolean) {
  return decideFilesystemOrphanUnderLock({
    claimants: filesystemOrphanClaimants(path),
    sharers,
    lockedAlive,
  })
}
