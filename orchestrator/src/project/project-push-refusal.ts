// concern: project-push-refusal
/** Formats refused hosted projects after the push loop has attempted every project. */

import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import type { RecordProjectSpaceConflictError } from '../record/record-project-space-contract.ts'

export function projectPushRefusalMessage(
  refusals: readonly RecordProjectSpaceConflictError[],
  memberships: readonly RecordSpaceMembership[],
): string {
  const lines = refusals.map((refusal) => {
    const requestSpace =
      recordSpaceMembership(refusal.spaceId, memberships)?.slug ?? refusal.spaceId
    return `- ${refusal.messageForRequestSpace(requestSpace)}`
  })
  return [
    `project push refused ${refusals.length} project${refusals.length === 1 ? '' : 's'} after pushing the rest:`,
    ...lines,
  ].join('\n')
}
