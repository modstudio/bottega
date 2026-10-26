// concern: pull-request merge policy
/** Classifies GitHub branch-policy merge refusals from the error text and check rollup. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type MergePolicyCheck = {
  name: string
  bucket: string
}

export type MergePolicyDecision = { policy: false } | { policy: true; refusal: string }

const POLICY_MESSAGE_SHAPES = [
  'base branch policy prohibits the merge',
  'is expected',
  'is in progress',
  'is failing',
] as const

function isGitHubBranchPolicyMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return POLICY_MESSAGE_SHAPES.some((shape) => normalized.includes(shape))
}

function blockedCheckLabels(checks: readonly MergePolicyCheck[]): string[] {
  const labels: string[] = []
  for (const check of checks) {
    if (check.bucket === 'pending') labels.push(`${check.name} pending`)
    if (check.bucket === 'fail') labels.push(`${check.name} failing`)
  }
  return labels
}

function policyListing(checks: readonly MergePolicyCheck[] | null): string | null {
  if (checks === null) return 'the checks could not be listed'
  const labels = blockedCheckLabels(checks)
  return labels.length > 0 ? labels.join(', ') : null
}

function policyRemedy(target: string, number: number | null): string {
  const retry = `${PLATFORM_SLUG} pr merge ${target}`
  const inspect = `gh pr checks ${number ?? target}`
  return `wait for pending checks and rerun ${retry}, or fix failing checks with ${inspect}`
}

export function decideMergePolicyRefusal(input: {
  message: string
  checks: readonly MergePolicyCheck[] | null
  target: string
  number: number | null
}): MergePolicyDecision {
  if (!isGitHubBranchPolicyMessage(input.message)) return { policy: false }
  const listing = policyListing(input.checks)
  const block = listing
    ? `GitHub's branch policy blocks the merge: ${listing}`
    : "GitHub's branch policy blocks the merge"
  return {
    policy: true,
    refusal: `${block}; cleared by: ${policyRemedy(input.target, input.number)}`,
  }
}
