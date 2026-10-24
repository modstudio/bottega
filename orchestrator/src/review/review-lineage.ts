// concern: review lineage
/** Resolves the review-history branches inherited by a freshly minted fix branch. */

export type BranchMintFact = {
  mintedBranch: string
  launchBase: string | null
  launchKey: string | null
}

/** Current branch first, followed by same-task minted ancestors until the first invalid link. */
export function branchReviewLineage(
  branch: string,
  mintFacts: readonly BranchMintFact[],
): string[] {
  const minted = new Map(mintFacts.map((fact) => [fact.mintedBranch, fact]))
  const lineage = [branch]
  const visited = new Set(lineage)
  let descendant = minted.get(branch)
  while (descendant?.launchBase) {
    const ancestor = minted.get(descendant.launchBase)
    if (
      !ancestor ||
      ancestor.launchKey !== descendant.launchKey ||
      visited.has(ancestor.mintedBranch)
    ) {
      break
    }
    lineage.push(ancestor.mintedBranch)
    visited.add(ancestor.mintedBranch)
    descendant = ancestor
  }
  return lineage
}
