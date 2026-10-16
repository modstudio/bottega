// concern: worktree-porcelain
/** Parses the worktree entries that Git itself marks as eligible for pruning. */

export type PrunableWorktree = {
  path: string
  reason: string
}

export function missingPrunableWorktrees(
  porcelain: string,
  directoryExists: (path: string) => boolean,
): PrunableWorktree[] {
  const missing: PrunableWorktree[] = []
  let path: string | null = null
  let reason: string | null = null
  const finishEntry = () => {
    if (path && reason && !directoryExists(path)) missing.push({ path, reason })
    path = null
    reason = null
  }

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      finishEntry()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('prunable ')) {
      reason = line.slice('prunable '.length)
    } else if (!line) {
      finishEntry()
    }
  }
  finishEntry()
  return missing
}
