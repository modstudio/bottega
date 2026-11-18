// concern: workflow promotion admission
/** Decides whether a checkout may put workflow definitions into production. */

export type WorkflowPromotionAdmission =
  | { verdict: 'allow'; reason: string | undefined; author: string | undefined }
  | { verdict: 'refuse'; message: string }

export function decideWorkflowPromotionAdmission(input: {
  landingBranch: string | null
  landingBranchContainsHead: boolean
  inspectionFailure?: string | null
  fromOperator: boolean
  reason?: string
  author?: string
  operatorName?: string | null
}): WorkflowPromotionAdmission {
  if (input.fromOperator) {
    return {
      verdict: 'allow',
      reason: input.reason,
      author: input.operatorName?.trim() || 'Shmuel Barkin',
    }
  }
  if (input.landingBranch && input.landingBranchContainsHead) {
    return { verdict: 'allow', reason: input.reason, author: input.author }
  }
  const condition = input.landingBranch
    ? input.inspectionFailure
      ? `containment by registered landing branch ${input.landingBranch} could not be established: ${input.inspectionFailure}`
      : `registered landing branch ${input.landingBranch} does not contain the checkout's HEAD`
    : 'the registered project has no landing branch'
  return {
    verdict: 'refuse',
    message:
      `refusing workflow promotion: ${condition}; ` +
      `land the workflow change by pull request, or obtain Shmuel Barkin's override and rerun with --from-operator`,
  }
}
