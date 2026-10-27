// concern: snapshotless tracked recipe safety

/** Direct an operator to the creator's matching removal tool without guessing what created the tree. */
export function unownedProjectTreeRemovalRemedy(input: {
  treePath: string
  mainCheckoutPath: string
}): string {
  return `if the orchestrator did not make this tree, remove it with the tool that made it, so whatever that tool provisioned for the tree is released too (a project's own worktree command, for example); only a plain git worktree is removed with git -C ${input.mainCheckoutPath} worktree remove ${input.treePath}, after confirming it is clean and its commits are pushed`
}

/** Refuse teardown when a tracked recipe cannot be reconstructed from a run snapshot. */
export function snapshotlessTrackedRecipeRefusal(input: {
  hasRunRow: boolean
  trackedRecipe: boolean
  treePath: string
  mainCheckoutPath: string
}): string | null {
  return !input.hasRunRow && input.trackedRecipe
    ? `no orchestrator run records the worktree at ${input.treePath}; what its tracked recipe provisioned cannot be established, so the orchestrator will not tear it down; ${unownedProjectTreeRemovalRemedy(input)}`
    : null
}
