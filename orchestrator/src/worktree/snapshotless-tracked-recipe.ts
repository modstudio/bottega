// concern: snapshotless tracked recipe safety

/** Refuse teardown when a tracked recipe cannot be reconstructed from a run snapshot. */
export function snapshotlessTrackedRecipeRefusal(input: {
  hasRunRow: boolean
  trackedRecipe: boolean
  treePath: string
  mainCheckoutPath: string
}): string | null {
  return !input.hasRunRow && input.trackedRecipe
    ? `no orchestrator run records the worktree at ${input.treePath}; what its tracked recipe provisioned cannot be established, so the orchestrator will not tear it down; if the orchestrator did not make this tree, confirm it is clean and its commits are pushed, then run git -C ${input.mainCheckoutPath} worktree remove ${input.treePath}`
    : null
}
