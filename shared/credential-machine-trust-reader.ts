import type { ConfigClient } from './config-client.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import {
  type CredentialMachine,
  type CredentialMachineTrustFacts,
  credentialMachineTrustFacts,
} from './credential-machine-trust.ts'
import { trustedKeysForSpace } from './trust-log-keys.ts'

/** Read and derive this machine's credential trust facts for one record space. */
export async function readCredentialMachineTrustFacts(
  client: Pick<ConfigClient, 'listMachineKeys' | 'readTrustLog'>,
  input: { spaceId: string; space: string; machine: CredentialMachine },
  env: ConfigEnvironment = process.env,
): Promise<CredentialMachineTrustFacts> {
  const [machineRows, trust] = await Promise.all([
    client.listMachineKeys({ destinationSpaceId: input.spaceId }),
    trustedKeysForSpace(client, input.spaceId, env),
  ])
  return credentialMachineTrustFacts({
    space: input.space,
    machine: input.machine,
    machineRows,
    trust,
  })
}
