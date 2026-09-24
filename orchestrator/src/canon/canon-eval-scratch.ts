// concern: canon-eval-scratch
/** Decides when an eval-owned scratch worktree may be released. */

import { join } from 'node:path'
import { type CleanupPresentation, discardRun } from '../cleanup/cleanup.ts'
import { db } from '../database/db.ts'

export function decideEvalOwnedScratchRelease(input: {
  scratchOwnedByEval: boolean
  runCreated: boolean
}): 'release' | 'none' {
  return input.scratchOwnedByEval && input.runCreated ? 'release' : 'none'
}

const presentation: CleanupPresentation = {
  log: () => {},
  error: () => {},
  setExitCode: () => {},
  keptBranchLine: (branch) => branch,
}

function recordedEvalScratchRunId(repo: string): number | null {
  const treeRoot = join(repo, '.claude', 'worktrees')
  const row = db()
    .query(
      `SELECT id FROM run
        WHERE worktree = ? OR worktree LIKE ? || '/%'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(treeRoot, treeRoot) as { id: number } | null
  return row?.id ?? null
}

/** Release an eval-owned scratch worktree through discard, then the caller deletes the repo. */
export async function releaseEvalOwnedScratchWorktree(
  repo: string,
  runId: number | null,
): Promise<void> {
  const id = runId ?? recordedEvalScratchRunId(repo)
  if (
    decideEvalOwnedScratchRelease({
      scratchOwnedByEval: true,
      runCreated: id !== null,
    }) !== 'release' ||
    id === null
  ) {
    return
  }
  await discardRun(id, {
    force: false,
    evalOwnedScratch: true,
    auditReason: 'canon-eval scratch',
    presentation,
  })
}
