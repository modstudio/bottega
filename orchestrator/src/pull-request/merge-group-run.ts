// concern: pull-request merge-group run identity
/** Owns the GitHub Actions branch rule that associates a merge-group run with a pull request. */

export type FailedMergeGroupRun = {
  id: number
  url: string
  conclusion: string
}

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

function failedMergeGroupRunFrom(
  raw: unknown,
  baseBranch: string,
  pullRequestNumber: number,
): (FailedMergeGroupRun & { createdAt: string }) | null {
  if (!isPullRequestMergeGroupRun(raw, baseBranch, pullRequestNumber)) return null
  if (raw.status !== 'completed') return null
  if (['success', 'skipped', 'neutral'].includes(String(raw.conclusion))) return null
  if (
    typeof raw.conclusion !== 'string' ||
    !Number.isSafeInteger(raw.id) ||
    typeof raw.html_url !== 'string' ||
    typeof raw.created_at !== 'string'
  ) {
    throw new Error('failed merge-group run lookup returned an unexpected run shape')
  }
  return {
    id: Number(raw.id),
    url: raw.html_url,
    conclusion: raw.conclusion,
    createdAt: raw.created_at,
  }
}

export function failedMergeGroupRunFromRuns(
  runs: readonly unknown[],
  baseBranch: string,
  pullRequestNumber: number,
): FailedMergeGroupRun | null {
  const matches = runs.flatMap((raw) => {
    const match = failedMergeGroupRunFrom(raw, baseBranch, pullRequestNumber)
    return match ? [match] : []
  })
  matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const match = matches[0]
  return match ? { id: match.id, url: match.url, conclusion: match.conclusion } : null
}
