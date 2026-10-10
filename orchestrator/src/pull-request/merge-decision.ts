// concern: pull-request merge proof
/** Decides whether immutable pull-request and proof facts admit a merge. */

export type PullRequestCheck = {
  name: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  state: string
  link: string
}

type PullRequestIdentityInput = {
  number: number
  state: string
  baseBranch: string
  landingBranch: string
}

type RequiredChecksProofInput = {
  kind: 'required-checks'
  number: number
  headCommit: string
  currentHeadCommit: string
  requiredChecks: readonly string[]
  checks: readonly PullRequestCheck[]
}

type LocalGateProofInput = {
  kind: 'local-gate'
  number: number
  headCommit: string
  currentHeadCommit: string
  landingBranch: string
  gate: { recorded: false } | { recorded: true; remoteLandingTip: string; mergeBase: string }
}

export type MergeProofInput = RequiredChecksProofInput | LocalGateProofInput

type MergeDecision = { admitted: true } | { admitted: false; refusal: string }

const rerun = (number: number) => `orch pr merge ${number}`

export function decidePullRequestIdentity(input: PullRequestIdentityInput): MergeDecision {
  if (input.state.toUpperCase() !== 'OPEN') {
    return {
      admitted: false,
      refusal: `pull request #${input.number} is ${input.state}, not open; cleared by: gh pr reopen ${input.number}, then ${rerun(input.number)}`,
    }
  }
  if (input.baseBranch !== input.landingBranch) {
    return {
      admitted: false,
      refusal: `pull request #${input.number} targets ${input.baseBranch}, not the registered landing branch ${input.landingBranch}; cleared by: gh pr edit ${input.number} --base ${input.landingBranch}, then ${rerun(input.number)}`,
    }
  }
  return { admitted: true }
}

export function decideMergeProof(input: MergeProofInput): MergeDecision {
  if (input.currentHeadCommit !== input.headCommit) {
    return {
      admitted: false,
      refusal: `pull request #${input.number} head changed from ${input.headCommit} to ${input.currentHeadCommit} while proof was checked; cleared by: ${rerun(input.number)}`,
    }
  }
  if (input.kind === 'required-checks') {
    const unproven = input.requiredChecks.flatMap((name) => {
      const matches = input.checks.filter((candidate) => candidate.name === name)
      if (matches.length === 0) return [`${name}: missing (no link returned)`]
      return matches
        .filter((check) => check.bucket !== 'pass')
        .map((check) => `${name}: ${check.state} (${check.link || 'no link returned'})`)
    })
    if (unproven.length > 0) {
      return {
        admitted: false,
        refusal:
          `required checks do not prove pull request #${input.number} head ${input.headCommit}: ${unproven.join('; ')}; ` +
          `cleared by: make every named check pass on ${input.headCommit}, then ${rerun(input.number)}`,
      }
    }
    return { admitted: true }
  }

  if (!input.gate.recorded) {
    return {
      admitted: false,
      refusal: `no passing local gate is recorded for pull request #${input.number} head ${input.headCommit}; cleared by: run orch gate run in the branch's tree, then ${rerun(input.number)}`,
    }
  }
  if (input.gate.remoteLandingTip !== input.gate.mergeBase) {
    return {
      admitted: false,
      refusal: `the registered landing branch ${input.landingBranch} moved to ${input.gate.remoteLandingTip} past merge base ${input.gate.mergeBase} for head ${input.headCommit}; cleared by: bring the branch up to origin/${input.landingBranch}, run orch gate run in the branch's tree, push it, then ${rerun(input.number)}`,
    }
  }
  return { admitted: true }
}
