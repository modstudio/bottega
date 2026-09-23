// concern: snapshotless tracked recipe safety

const SNAPSHOTLESS_TRACKED_RECIPE_REFUSAL =
  'tracked recipe tree has no recorded recipe snapshot; teardown cannot be established'

/** Refuse teardown when a tracked recipe cannot be reconstructed from a run snapshot. */
export function snapshotlessTrackedRecipeRefusal(input: {
  hasRunRow: boolean
  trackedRecipe: boolean
}): string | null {
  return !input.hasRunRow && input.trackedRecipe ? SNAPSHOTLESS_TRACKED_RECIPE_REFUSAL : null
}
