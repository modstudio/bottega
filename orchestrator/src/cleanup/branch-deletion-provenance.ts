/** Decide whether a run conversation may delete a recorded branch. */
export function branchDeletableBy(
  target: string | null,
  conversationMintedBranches: readonly (string | null)[],
): boolean {
  return target !== null && conversationMintedBranches.some((branch) => branch === target)
}
