// concern: stopped-worktree-decision
/** Formats the stop worktree line from whether this process released the tree. Must not know storage, git, or the CLI. */

export function stoppedWorktreeLine(
  released: boolean,
  worktree: string,
  branch: string | null,
  branchOwnedByConversation: boolean,
  dockerMessage: string,
): string {
  if (released) return `released worktree ${worktree}; ${dockerMessage}`
  const keptBranch = branchOwnedByConversation ? ` and branch ${branch}` : ''
  return `kept worktree ${worktree}${keptBranch} for continuation; ${dockerMessage}`
}
