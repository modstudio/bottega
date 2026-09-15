// concern: isolation
/** Owns explicit reclamation command behavior. Must not know CLI grammar. */
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'

export function reclaimCommand(
  kind: string,
  subject: string,
  dryRun: boolean,
  presentation: { log(value: string): void },
): void {
  if (kind !== 'worktree' && kind !== 'branch') {
    throw new Error(
      `unknown reclaim kind ${JSON.stringify(kind)}: use orch reclaim worktree <path> [--dry-run] or orch reclaim branch <project>:<branch> [--dry-run]`,
    )
  }
  const result =
    kind === 'worktree' ? reclaimWorktree(subject, { dryRun }) : reclaimBranch(subject, { dryRun })
  if (!result.ok) throw new Error(result.action)
  presentation.log(result.action)
}
