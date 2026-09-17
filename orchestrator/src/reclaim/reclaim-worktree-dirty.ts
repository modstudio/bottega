// concern: reclaim-worktree-dirty
/** Pure dirty-tree refusal for worktree reclaim. Must not know git, databases, or CLI. */

export type ReclaimDirtyTreeFacts = {
  path: string
  treeExists: boolean
  dirty: { dirty: boolean; detail: string }
}

/** Refuse reclaim when an existing tree holds uncommitted work or cannot be inspected. */
export function reclaimDirtyTreeRefusal(
  facts: ReclaimDirtyTreeFacts,
): { ok: false; action: string } | null {
  if (!facts.treeExists || !facts.dirty.dirty) return null
  return {
    ok: false,
    action: `refused; worktree ${facts.path} ${facts.dirty.detail}; commit or discard the changes and retry`,
  }
}
