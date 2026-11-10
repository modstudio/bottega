// concern: workflows
/** Resolves explicit destinations for project-less workflow catalogue writes. */

import { resolveRecordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import { flagValue } from '../cli/args.ts'
import { recordMemberships } from '../record/record-space.ts'

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
    async () => (await recordMemberships()).memberships,
  )
  return destination.spaceId
}
