// concern: pull-request release notice
/** Reports required release rungs without changing pull-request creation admission. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RequiredRungDecision } from '../release/release-required.ts'
import { requiredMergeCommand } from './pr-post-landing-payload.ts'

export function pullRequestReleaseNotice(input: {
  decision: RequiredRungDecision
  target: string | null
  depth?: string
}): string | null {
  if (!input.decision.decided) {
    return `release rung requirement could not be decided: ${input.decision.error}; ${PLATFORM_SLUG} pr merge decides it again`
  }
  const explicitlyRequired = input.decision.rungs
    .filter(({ required, requiredBy }) => required && requiredBy === 'explicit')
    .map(({ rung }) => rung)
  if (explicitlyRequired.length === 0) return null
  const requirement = `${
    explicitlyRequired.length === 1 ? 'release rung' : 'release rungs'
  } ${explicitlyRequired.join(', ')} required by this pull request`
  return input.target
    ? `${requirement}; merge with: ${requiredMergeCommand(input.target, input.depth)}`
    : requirement
}
