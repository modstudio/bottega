// concern: project-push-refusal
/** Formats refused hosted projects after the push loop has attempted every project. */

import type { RecordSpaceMembership } from '../../../shared/record-space-membership.ts'
import type { RecordProjectSpaceConflictError } from '../record/record-project-space-refusal.ts'

export function projectPushRefusalMessage(
  refusals: readonly RecordProjectSpaceConflictError[],
  memberships: readonly RecordSpaceMembership[],
): string {
  const lines = refusals.map((refusal) => {
    const requestSpace =
      memberships.find((membership) => membership.spaceId === refusal.spaceId)?.slug ??
      refusal.spaceId
    return `- ${refusal.messageForRequestSpace(requestSpace)}`
  })
  return [
    `project push refused ${refusals.length} project${refusals.length === 1 ? '' : 's'} after pushing the rest:`,
    ...lines,
  ].join('\n')
}
