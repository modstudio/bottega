/** Decides when an eval-owned scratch worktree may be released and whether a recorded tree belongs to that scratch. */

const MAC_PRIVATE_PREFIX = '/private'

export function decideEvalOwnedScratchRelease(input: {
  scratchOwnedByEval: boolean
  runCreated: boolean
}): 'release' | 'none' {
  return input.scratchOwnedByEval && input.runCreated ? 'release' : 'none'
}

/** macOS `/var` is a symlink to `/private/var`; strip that prefix when realpath is unavailable. */
function withoutPrivatePrefix(path: string): string {
  return path.startsWith(`${MAC_PRIVATE_PREFIX}/`) ? path.slice(MAC_PRIVATE_PREFIX.length) : path
}

export function decideEvalScratchWorktreeMatch(input: {
  worktree: string
  scratchTreeRoot: string
}): boolean {
  const prefix = `${input.scratchTreeRoot}/`
  if (input.worktree === input.scratchTreeRoot || input.worktree.startsWith(prefix)) return true
  const worktree = withoutPrivatePrefix(input.worktree)
  const root = withoutPrivatePrefix(input.scratchTreeRoot)
  return worktree === root || worktree.startsWith(`${root}/`)
}

export function thrownEvalRunId(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('runId' in error)) return null
  const value = error.runId
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}
