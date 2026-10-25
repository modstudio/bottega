// concern: pull-request merge-group run identity
/** Owns the GitHub Actions branch rule that associates a merge-group run with a pull request. */

export function isPullRequestMergeGroupRun(
  value: unknown,
  baseBranch: string,
  pullRequestNumber: number,
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('GitHub workflow run is not an object')
  }
  const row = value as Record<string, unknown>
  if (typeof row.event !== 'string' || typeof row.head_branch !== 'string') {
    throw new Error('GitHub workflow run has an unexpected identity shape')
  }
  return (
    row.event === 'merge_group' &&
    row.head_branch.startsWith(`gh-readonly-queue/${baseBranch}/pr-${pullRequestNumber}-`)
  )
}
