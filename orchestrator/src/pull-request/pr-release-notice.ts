// concern: pull-request release notice
/** Reports required release rungs without changing pull-request creation admission. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  explicitlyRequiredRungs,
  type RequiredRungDecision,
  requiredRungSentence,
} from '../release/release-required.ts'
import { requiredMergeCommand } from './pr-post-landing-payload.ts'

export function pullRequestReleaseNotice(input: {
  decision: RequiredRungDecision
  target: string | null
}): string | null {
  if (!input.decision.decided) {
    return `release rung requirement could not be decided: ${input.decision.error}; ${PLATFORM_SLUG} pr merge decides it again`
  }
  const explicitlyRequired = explicitlyRequiredRungs(input.decision)
  if (explicitlyRequired.length === 0) return null
  const requirement = requiredRungSentence(explicitlyRequired)
  return input.target
    ? `${requirement}; merge with: ${requiredMergeCommand(input.target)}`
    : requirement
}
