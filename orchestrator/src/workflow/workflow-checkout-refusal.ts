// concern: workflow checkout evidence diagnostics
/** Classifies checkout provenance and names an outside-change remedy. */

export type CheckoutResolution = {
  project: string | null
  branch: string | null
  checkoutPath?: string
  headIsTipOrAncestor: boolean
  landingCommit?: string | null
  landingIsHeadOrAncestor?: boolean
  landingBranch: string
}

export type CheckoutEvidenceLocation = 'branch' | 'post-landing' | 'outside-change'

type CheckoutAnswer = { checkoutPath: string } | { refusal: string }

/** Chooses the checkout that can answer git provenance questions for recorded evidence. */
export function decideCheckoutAnswer(input: {
  recordedCwd: string
  recordedCwdIsDirectory: boolean
  mainCheckoutPath: string | null
}): CheckoutAnswer {
  if (input.recordedCwdIsDirectory) return { checkoutPath: input.recordedCwd }
  if (input.mainCheckoutPath) return { checkoutPath: input.mainCheckoutPath }
  return {
    refusal: `recorded evidence cwd ${input.recordedCwd} is no longer a directory and the cursor project has no registered main checkout`,
  }
}

/** Decides whether a commit belongs to the change before or after its recorded landing. */
export function classifyCheckoutEvidence(input: {
  headIsTipOrAncestor: boolean
  landingCommit: string | null
  landingIsHeadOrAncestor: boolean
}): CheckoutEvidenceLocation {
  if (input.headIsTipOrAncestor) return 'branch'
  if (input.landingCommit && input.landingIsHeadOrAncestor) return 'post-landing'
  return 'outside-change'
}

export function checkoutOutsideChangeRefusal(
  flag: string,
  identityBranch: string,
  cwd: string,
  checkout: CheckoutResolution,
): string {
  if (checkout.landingCommit && checkout.landingIsHeadOrAncestor === undefined) {
    return (
      `${flag} could not establish whether head_commit belongs to ${identityBranch} because ` +
      `landing commit ${checkout.landingCommit} is not available in ${cwd}; ` +
      `run \`git pull --ff-only origin ${checkout.landingBranch}\` in that checkout`
    )
  }
  return (
    `${flag} head_commit does not belong to ${identityBranch} or its recorded landing; ` +
    `use evidence recorded from that change's checkout`
  )
}
