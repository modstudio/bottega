// concern: isolation
/** Owns explicit reclamation command behavior. Must not know CLI grammar. */
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'

export function reclaimCommand(kind: 'worktree' | 'branch', subject: string, dryRun: boolean, presentation: { log(value: string): void }): void {
  const result = kind === 'worktree' ? reclaimWorktree(subject, { dryRun }) : reclaimBranch(subject, { dryRun })
  if (!result.ok) throw new Error(result.action)
  presentation.log(result.action)
}
