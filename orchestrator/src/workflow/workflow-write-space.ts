// concern: workflows
/** Resolves explicit destinations for project-less workflow catalogue writes. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { resolveRecordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import { flagValue } from '../cli/args.ts'
import { recordApiClient } from '../record/record-api-client.ts'

export const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

export const obligationUuid = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (!hasRecordIdShape(value))
    throw new Error(
      `--satisfies must be an obligation UUID from ${PLATFORM_SLUG} workflow cursors --json`,
    )
  return value.toLowerCase()
}

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
