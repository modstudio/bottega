// concern: machine-trust
/** Routes machine trust through the pinned-space service or a named-space service. */

import type { ConfigClient } from '../../../shared/config-client.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { machineTrust } from './config-service.ts'
import { machineTrustInSpace } from './named-space-config.ts'

export function trustUsesPinnedSpace(
  pinnedSpaceId: string | null,
  selectedSpaceId: string,
): boolean {
  return pinnedSpaceId === selectedSpaceId
}

export async function trustMachine(
  keyId: string,
  publicKey: string,
  label: string,
  selected: { spaceId: string; slug: string },
  client: ConfigClient,
): Promise<void> {
  if (trustUsesPinnedSpace(readHostedConfigIdentity()?.spaceId ?? null, selected.spaceId)) {
    await machineTrust(keyId, publicKey, label, selected, client)
    return
  }
  await machineTrustInSpace(keyId, publicKey, label, selected, client)
}
