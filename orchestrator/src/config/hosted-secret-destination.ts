// concern: hosted-secret-destination
/** Opens a selected hosted secret in its project destination space. */

import {
  type ConfigClient,
  ConfigClientError,
  type ConfigDestination,
  type ConfigSecret,
  type DataKey,
} from '../../../shared/config-client.ts'
import { hostedIdentity, openHostedSecret } from '../../../shared/hosted-secret-opening.ts'
import { configAccessRemedy } from '../../../shared/record-remedies.ts'
import { readTrustList } from '../../../shared/trust-list.ts'
import { localMachine } from './config-service.ts'

/** Open an already-selected secret; plaintext remains in memory. */
export async function openSecretInDestination(
  row: ConfigSecret,
  destination: ConfigDestination,
  client: ConfigClient,
): Promise<string> {
  if (!destination.destinationSpaceId)
    throw new Error('opening a project secret requires a destination space')
  const machine = await localMachine()
  const identity = await hostedIdentity(client, undefined, {
    spaceId: destination.destinationSpaceId,
    machineKeyId: machine.keyId,
    configAccess: true,
  })
  let full: ConfigSecret & { envelope: string }
  let key: DataKey
  try {
    ;[full, key] = await Promise.all([
      client.getSecret(row.key, row.scope, row.environment, destination),
      client.getDataKey(row.dekId, machine.keyId, destination),
    ])
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 422)
      throw new Error(configAccessRemedy(destination.destinationSpaceId))
    throw error
  }
  const plaintext = await openHostedSecret({
    client,
    row: full,
    key,
    machine,
    trust: await readTrustList(),
    expected: { key: row.key, scope: row.scope, environment: row.environment },
    identity,
  })
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
}
