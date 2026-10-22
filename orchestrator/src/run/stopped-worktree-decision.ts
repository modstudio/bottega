// concern: stopped-worktree-decision
/** Picks the stop worktree message from job and tree facts. Must not know storage, git, or the CLI. */

export type StoppedWorktreeDisposition = 'keep' | 'release' | 'none'

export function stoppedWorktreeDisposition(input: {
  readOnlyJob: boolean
  worktree: string | null
}): StoppedWorktreeDisposition {
  if (!input.worktree) return 'none'
  return input.readOnlyJob ? 'release' : 'keep'
}

export function stoppedWorktreeLine(
  disposition: Exclude<StoppedWorktreeDisposition, 'none'>,
  worktree: string,
  branch: string | null,
  branchOwnedByConversation: boolean,
  dockerMessage: string,
): string {
  if (disposition === 'release') return `released worktree ${worktree}; ${dockerMessage}`
  const keptBranch = branchOwnedByConversation ? ` and branch ${branch}` : ''
  return `kept worktree ${worktree}${keptBranch} for continuation; ${dockerMessage}`
}
