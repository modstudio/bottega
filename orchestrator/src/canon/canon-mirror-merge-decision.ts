export type ChecksState = 'passed' | 'failed' | 'pending'
export type MergeDecision = { merge: true } | { merge: false; reason: string }

export function canonMirrorMergeArgs(number: number, commit: string): string[] {
  return ['gh', 'pr', 'merge', String(number), '--squash', '--match-head-commit', commit]
}

export function decideCanonMirrorMerge(input: {
  shipLevel: string
  headMatches: boolean
  baseUnchanged: boolean
  checks: ChecksState
}): MergeDecision {
  if (input.shipLevel !== 'auto')
    return { merge: false, reason: `ship autonomy is ${input.shipLevel}` }
  if (!input.headMatches)
    return { merge: false, reason: 'pull-request head does not match the pushed commit' }
  if (!input.baseUnchanged)
    return { merge: false, reason: 'the landing branch changed after hydration was planned' }
  if (input.checks !== 'passed')
    return { merge: false, reason: `GitHub checks are ${input.checks}` }
  return { merge: true }
}
