// concern: pull-request merge policy
/** Classifies GitHub branch-policy merge refusals from the error text and check rollup. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { PullRequestCheck } from './merge-decision.ts'

export type MergePolicyDecision = { policy: false } | { policy: true; refusal: string }

const POLICY_MESSAGE = 'base branch policy prohibits the merge'

function isGitHubBranchPolicyMessage(message: string): boolean {
  return message.toLowerCase().includes(POLICY_MESSAGE)
}

function blockedCheckLabel(check: PullRequestCheck): string | null {
  switch (check.bucket) {
    case 'pending':
      return `${check.name} pending`
    case 'fail':
      return `${check.name} failing`
    case 'cancel':
      return `${check.name} cancelled`
    case 'pass':
    case 'skipping':
      return null
  }
}

function blockedCheckLabels(checks: readonly PullRequestCheck[]): string[] {
  return checks.flatMap((check) => {
    const label = blockedCheckLabel(check)
    return label === null ? [] : [label]
  })
}

/** One clearing action per blocking bucket present, so each named state has its own remedy. */
function blockedCheckRemedies(checks: readonly PullRequestCheck[], inspect: string): string[] {
  const buckets = new Set(checks.map((check) => check.bucket))
  const remedies: string[] = []
  if (buckets.has('pending')) remedies.push('wait for pending checks')
  if (buckets.has('fail')) remedies.push(`fix failing checks with gh pr checks ${inspect}`)
  if (buckets.has('cancel')) remedies.push(`re-run cancelled checks from gh pr checks ${inspect}`)
  return remedies
}

function inspectRef(number: number | null, target: string): string {
  return String(number ?? target)
}

function retryCommand(target: string): string {
  return `${PLATFORM_SLUG} pr merge ${target}`
}

function policyRefusal(input: {
  checks: readonly PullRequestCheck[] | null
  target: string
  number: number | null
}): string {
  const inspect = inspectRef(input.number, input.target)
  const retry = retryCommand(input.target)
  if (input.checks === null) {
    return (
      "GitHub's branch policy blocks the merge: the checks could not be listed and the block may be a check or another requirement; " +
      `cleared by: gh pr checks ${inspect}, gh pr view ${inspect}, then rerun ${retry}`
    )
  }
  const labels = blockedCheckLabels(input.checks)
  if (labels.length > 0) {
    return (
      `GitHub's branch policy blocks the merge: ${labels.join(', ')}; ` +
      `cleared by: ${blockedCheckRemedies(input.checks, inspect).join(', or ')}, then rerun ${retry}`
    )
  }
  return (
    "GitHub's branch policy blocks the merge: the block is not a check, but another branch requirement such as a review approval, conversation resolution or a required deployment; " +
    `cleared by: gh pr view ${inspect} to see the unmet requirement, then rerun ${retry}`
  )
}

export function decideMergePolicyRefusal(input: {
  message: string
  checks: readonly PullRequestCheck[] | null
  target: string
  number: number | null
}): MergePolicyDecision {
  if (!isGitHubBranchPolicyMessage(input.message)) return { policy: false }
  return { policy: true, refusal: policyRefusal(input) }
}
