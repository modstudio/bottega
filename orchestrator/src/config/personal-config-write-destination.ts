// concern: personal config write destination
/** Resolves the account-owned destination shared by config and credential writes. */

import type { ConfigClient, ConfigWriteDestination } from '../../../shared/config-client.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'
import { hostedConfigClient } from './hosted-config-call-outcome.ts'

export async function personalConfigWriteDestination(
  client: ConfigClient = hostedConfigClient(),
): Promise<ConfigWriteDestination> {
  const who = await client.whoami()
  const decision = recordWriteSpace(
    { kind: 'personal' },
    { declaredSpaces: {}, personalSpaceId: who.personalSpaceId, memberships: [] },
  )
  if ('refused' in decision) throw new Error(decision.remedy)
  return { destinationSpaceId: decision.spaceId }
}
