// concern: stopped-worktree-decision
/** Formats the stop worktree line from caller-supplied facts. Must not know storage, git, or the CLI. */

export type StoppedWorktreeReleaseOutcome = 'released' | 'not-applicable' | 'kept'

export function stoppedWorktreeLine(
  releaseOutcome: StoppedWorktreeReleaseOutcome,
  worktree: string,
  branch: string | null,
  branchOwnedByConversation: boolean,
  detail: string | null,
  recordId: string,
  platformSlug: string,
  dockerMessage: string,
): string {
  if (releaseOutcome === 'released') return `released worktree ${worktree}; ${dockerMessage}`
  if (releaseOutcome === 'kept') {
    const detailSummary = detail
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean)
    const keptDetail = detailSummary ? `: ${detailSummary}` : ''
    return `left reader clone ${worktree} in place${keptDetail}; it is released by a later close-out or ${platformSlug} machine sweep, or by ${platformSlug} run discard ${recordId}; ${dockerMessage}`
  }
  const keptBranch = branchOwnedByConversation ? ` and branch ${branch}` : ''
  return `kept worktree ${worktree}${keptBranch} for continuation; ${dockerMessage}`
}
