// concern: workflows
/** Resolves explicit destinations for project-less workflow catalogue writes. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import { flagValue } from '../cli/args.ts'
import { recordApiClient } from '../record/record-api-client.ts'

export const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

export async function workflowWriteSpace(verb: string, argv: string[]): Promise<string> {
  const requested = flagValue(argv, 'space')
  if (!requested) {
    const missing = recordSpaceOwnerDestination(verb, { space: requested }, [])
    if (missing.kind === 'refused') throw new Error(missing.remedy)
  }
  const identity = await recordApiClient().whoami()
  const destination = recordSpaceOwnerDestination(
    verb,
    { space: requested },
    parseRecordSpaceMemberships(identity.memberships),
  )
  if (destination.kind === 'refused') throw new Error(destination.remedy)
  if (destination.kind !== 'space') throw new Error('workflow space owner was not resolved')
  return destination.spaceId
}
