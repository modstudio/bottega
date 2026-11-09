// concern: hosted-secret-row
/** Owns opening one hosted secret row for this machine in the active or a destination space. */

import { PLATFORM_SLUG } from './brand.ts'
import type { ConfigClient, ConfigDestination, ConfigSecret } from './config-client.ts'
import { hostedSecretIdentity, openHostedSecret } from './hosted-secret-opening.ts'
import { machineKeyInfo, readMachineKey } from './machine-key-store.ts'
import { readTrustList } from './trust-list.ts'

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
  const identity = await hostedSecretIdentity(client, destination, local.keyId)
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
