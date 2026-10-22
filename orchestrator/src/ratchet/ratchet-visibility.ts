// concern: ratchet visibility decision
/** Distinguishes an irrelevant empty comparison from a ratchet that missed a real change. */

export function ratchetVisibility(input: {
  comparisonPaths: readonly string[]
  visiblePaths: readonly string[]
}): { visible: true } | { visible: false; reason: string } {
  if (input.comparisonPaths.length === 0 || input.visiblePaths.length > 0) return { visible: true }
  return {
    visible: false,
    reason: 'ratchet could not see the working-tree change against its comparison base',
  }
}
