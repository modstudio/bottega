// concern: hosted-secret-row
/** Owns opening one hosted secret row for this machine in the active or a destination space. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  type ConfigDestination,
  type ConfigSecret,
} from '../../../shared/config-client.ts'
import {
  destinationHostedIdentity,
  hostedIdentity,
  openHostedSecret,
} from '../../../shared/hosted-secret-opening.ts'
import { machineKeyInfo, readMachineKey } from '../../../shared/machine-key-store.ts'
import { readTrustList } from '../../../shared/trust-list.ts'

export function localMachine() {
  const pair = readMachineKey()
  if (!pair)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  return machineKeyInfo(pair)
}

/** Open an already-selected secret; plaintext remains in memory. */
export async function openHostedSecretRow(
  client: ConfigClient,
  row: ConfigSecret,
  destination: ConfigDestination = {},
  machine?: Awaited<ReturnType<typeof localMachine>>,
): Promise<Uint8Array> {
  const local = machine ?? (await localMachine())
  const identity = destination.destinationSpaceId
    ? await destinationHostedIdentity(client, {
        spaceId: destination.destinationSpaceId,
        machineKeyId: local.keyId,
      })
    : await hostedIdentity(client)
  const [full, key, trust] = await Promise.all([
    client.getSecret(row.key, row.scope, row.environment, destination),
    client.getDataKey(row.dekId, local.keyId, destination),
    readTrustList(),
  ])
  return openHostedSecret({
    row: full,
    key,
    machine: local,
    trust,
    expected: { key: row.key, scope: row.scope, environment: row.environment },
    identity,
  })
}
