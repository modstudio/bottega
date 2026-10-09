// concern: pull-request merge proof
/** Decides whether immutable pull-request and proof facts admit a merge. */

export type PullRequestCheck = {
  name: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  state: string
  link: string
}

export type MergeProofInput = {
  number: number
  state: string
  baseBranch: string
  landingBranch: string
  headCommit: string
  requiredChecks: readonly string[]
  checks: readonly PullRequestCheck[]
  passingGateId: number | null
  remoteLandingTip: string | null
  mergeBase: string | null
}

export type MergeProofDecision = { admitted: true } | { admitted: false; refusal: string }

const rerun = (number: number) => `orch pr merge ${number}`

export function decideMergeProof(input: MergeProofInput): MergeProofDecision {
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

  if (input.requiredChecks.length > 0) {
    const unproven = input.requiredChecks.flatMap((name) => {
      const check = input.checks.find((candidate) => candidate.name === name)
      if (check?.bucket === 'pass') return []
      return [
        check
          ? `${name}: ${check.state} (${check.link || 'no link returned'})`
          : `${name}: missing (no link returned)`,
      ]
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

  if (input.passingGateId === null) {
    return {
      admitted: false,
      refusal: `no passing local gate is recorded for pull request #${input.number} head ${input.headCommit}; cleared by: run orch gate run in the branch's tree, then ${rerun(input.number)}`,
    }
  }
  if (input.remoteLandingTip === null || input.mergeBase === null) {
    return {
      admitted: false,
      refusal: `the remote ${input.landingBranch} tip and its merge base with ${input.headCommit} were not established; cleared by: git fetch origin ${input.landingBranch}, then ${rerun(input.number)}`,
    }
  }
  if (input.remoteLandingTip !== input.mergeBase) {
    return {
      admitted: false,
      refusal: `the registered landing branch ${input.landingBranch} moved to ${input.remoteLandingTip} past merge base ${input.mergeBase} for head ${input.headCommit}; cleared by: bring the branch up to origin/${input.landingBranch}, run orch gate run in the branch's tree, push it, then ${rerun(input.number)}`,
    }
  }
  return { admitted: true }
}
