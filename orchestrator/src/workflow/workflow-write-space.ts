// concern: workflows
/** Resolves explicit destinations for project-less workflow catalogue writes. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { resolveRecordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import { flagValue } from '../cli/args.ts'
import { recordApiClient } from '../record/record-api-client.ts'

export async function workflowWriteSpace(
  verb: string,
  argv: string[],
  hostedConfigured: boolean,
): Promise<string> {
  if (!hostedConfigured) return ''
  const requested = flagValue(argv, 'space')
  const destination = await resolveRecordSpaceOwnerDestination(
    verb,
    { space: requested },
    [],
    async () => parseRecordSpaceMemberships((await recordApiClient().whoami()).memberships),
  )
  if (destination.kind !== 'space') throw new Error('workflow space owner was not resolved')
  return destination.spaceId
}
