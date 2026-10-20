// concern: branch-state
/** Pure decisions for carrying landing proof through local branch containment. */

export type BranchContainmentFact = {
  branch: string
  directlyLanded: boolean
  containingBranches: readonly string[]
}

/**
 * Resolve containment transitively, while requiring every chain to terminate at
 * a branch with its own non-containment landing proof. Callers provide strict
 * containment: branches at equal tips do not contain one another.
 */
export function decideBranchContainment(
  facts: readonly BranchContainmentFact[],
): ReadonlyMap<string, string> {
  const proven = new Set(facts.filter((fact) => fact.directlyLanded).map((fact) => fact.branch))
  const containedBy = new Map<string, string>()
  let changed = true
  while (changed) {
    changed = false
    for (const fact of facts) {
      if (proven.has(fact.branch)) continue
      const containingBranch = fact.containingBranches.find((branch) => proven.has(branch))
      if (!containingBranch) continue
      proven.add(fact.branch)
      containedBy.set(fact.branch, containingBranch)
      changed = true
    }
  }
  return containedBy
}

export type MergeLandingBranchFact = {
  branch: string
  tip: string
  carriesTaskKey: boolean
  tipIsAncestorOfAdmittedHead: boolean
}

/**
 * Select the exact tips that merge-time recording may persist. Containment is
 * strict: a tip equal to the admitted head is not its ancestor; the task branch
 * is recorded separately at the admitted head.
 */
export function decideMergeLandingBranches(input: {
  taskBranch: string
  admittedHead: string
  branches: readonly MergeLandingBranchFact[]
}): { branch: string; tip: string }[] {
  const selected = input.branches.flatMap((fact) =>
    fact.carriesTaskKey && fact.tipIsAncestorOfAdmittedHead
      ? [{ branch: fact.branch, tip: fact.tip }]
      : [],
  )
  if (!selected.some((candidate) => candidate.branch === input.taskBranch)) {
    selected.push({ branch: input.taskBranch, tip: input.admittedHead })
  }
  return selected
}
