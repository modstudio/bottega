// concern: filed-issue failure disposition
/** Purely decides whether a failed fix tree contains state absent from its branch. */

export type CatchFixTree = { path: string; branch: string }

export function catchFixTreeDisposition(
  tree: CatchFixTree | null,
  dirty: boolean,
): { action: 'hold' | 'release' | 'none'; handoff: string } {
  if (!tree) return { action: 'none', handoff: 'Fix worktree: none recorded.' }
  if (dirty) {
    return {
      action: 'hold',
      handoff: `Worktree held at ${tree.path}: uncommitted work; not reconstructible from the branch ${tree.branch}.`,
    }
  }
  return {
    action: 'release',
    handoff: `Worktree released; committed work remains on branch ${tree.branch}.`,
  }
}
