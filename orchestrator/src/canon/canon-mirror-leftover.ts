// concern: canon-mirror-leftover
/** Decides how a canon-mirror pass treats a worktree left by an earlier pass. */

export type LeftoverDisposition =
  | { action: 'release' }
  | { action: 'reclaim' }
  | { action: 'refuse' }
  | { action: 'report'; would: 'release' | 'reclaim' | 'refuse' }

export function decideLeftoverDisposition(input: {
  exists: boolean
  owned: boolean
  dirty: boolean
  hasUnpushedCommit: boolean
  dryRun: boolean
}): LeftoverDisposition {
  const action = !input.exists
    ? 'release'
    : !input.owned || input.hasUnpushedCommit
      ? 'refuse'
      : input.dirty
        ? 'reclaim'
        : 'release'
  return input.dryRun && input.exists ? { action: 'report', would: action } : { action }
}
