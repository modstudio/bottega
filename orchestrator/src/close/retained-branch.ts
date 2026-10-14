/** Close-out retains only a branch minted by this conversation. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
export function retainedBranchForCloseOut(mintedBranch: string | null): string | null {
  return mintedBranch
}

/** Explain the recovery claim represented by a retained run branch. */
export function retainedBranchReason(branch: string): string {
  return `${branch} is kept so this run's commits stay recoverable until the task lands`
}

/** Name the task-scoped classifier and cleanup for a retained run branch. */
export function retainedBranchPruneCommand(
  project: string | null,
  key: string | null,
): string | null {
  return project && key
    ? `${PLATFORM_SLUG} tree branch prune --project ${project} --key ${key}`
    : null
}
