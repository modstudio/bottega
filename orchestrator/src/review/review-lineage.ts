// concern: review lineage
/** Resolves the review-history branches inherited by a freshly minted fix branch. */

export type BranchMintFact = {
  mintedBranch: string
  launchBase: string | null
  launchKey: string | null
  headCommit: string | null
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
    const launchBase = descendant.launchBase.replace(/^refs\/heads\//, '')
    const launchKey = descendant.launchKey
    const headMatches = /^[0-9a-f]{7,40}$/.test(launchBase)
      ? [
          ...new Map(
            mintFacts
              .filter(
                (fact) =>
                  fact.launchKey === launchKey &&
                  !visited.has(fact.mintedBranch) &&
                  fact.headCommit?.startsWith(launchBase),
              )
              .map((fact) => [fact.mintedBranch, fact]),
          ).values(),
        ]
      : []
    const ancestor =
      minted.get(launchBase) ?? (headMatches.length === 1 ? headMatches[0] : undefined)
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
