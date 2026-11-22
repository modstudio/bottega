// concern: canon-mirror-leftover
/** Decides how a canon-mirror pass treats a worktree left by an earlier pass. */

export type LeftoverDisposition =
  | { action: 'release' }
  | { action: 'reclaim' }
  | { action: 'refuse'; reason: 'indeterminate-cleanliness' | 'unpushed-commits' }
  | {
      action: 'report'
      would: 'release' | 'reclaim' | 'refuse'
      reason?: 'indeterminate-cleanliness' | 'unpushed-commits'
    }

export function decideLeftoverDisposition(input: {
  dirty: boolean | 'indeterminate'
  unpushedCommitCount: number
  dryRun: boolean
}): LeftoverDisposition {
  const disposition: Exclude<LeftoverDisposition, { action: 'report' }> =
    input.dirty === 'indeterminate'
      ? { action: 'refuse', reason: 'indeterminate-cleanliness' }
      : input.unpushedCommitCount > 0
        ? { action: 'refuse', reason: 'unpushed-commits' }
        : input.dirty
          ? { action: 'reclaim' }
          : { action: 'release' }
  return input.dryRun
    ? {
        action: 'report',
        would: disposition.action,
        ...(disposition.action === 'refuse' ? { reason: disposition.reason } : {}),
      }
    : disposition
}

export function leftoverDispositionMessage(
  disposition: LeftoverDisposition,
  input: { path: string; branch: string; unpushedCommitCount: number },
): string | null {
  if (disposition.action === 'release' || disposition.action === 'reclaim') return null
  const cause =
    disposition.reason === 'indeterminate-cleanliness'
      ? 'its cleanliness is indeterminate'
      : `it has ${input.unpushedCommitCount} unpushed commit${input.unpushedCommitCount === 1 ? '' : 's'}`
  if (disposition.action === 'refuse')
    return `refusing owned canon mirror leftover ${input.path} on branch ${input.branch}: ${cause}; the tree was left intact`
  if (disposition.would === 'reclaim') return 'owned leftover would be reset and released'
  if (disposition.would === 'release') return 'owned leftover would be released'
  return `owned leftover would be refused because ${cause.replace(/^it /, '')}`
}
