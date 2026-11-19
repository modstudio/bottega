// concern: hosted-secret-write-target
/** Owns the pinned-space policy for flagged and unflagged sealed-secret commands. */
import type {
  ConfigClient,
  ConfigScope,
  ConfigWriteDestination,
} from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { pinnedHostedSecretDestination } from '../../../shared/hosted-secret-opening.ts'

export async function pinnedConfigDestination(
  client: ConfigClient,
  env: ConfigEnvironment = process.env,
): Promise<ConfigWriteDestination> {
  return pinnedHostedSecretDestination(client, readHostedConfigIdentity(env))
}

export async function secretWriteTarget(
  selectedSpaceId: string | undefined,
  client: ConfigClient,
  env: ConfigEnvironment = process.env,
): Promise<{ scope: ConfigScope; destination: ConfigWriteDestination }> {
  return selectedSpaceId
    ? { scope: 'space', destination: { destinationSpaceId: selectedSpaceId } }
    : { scope: 'user', destination: await pinnedConfigDestination(client, env) }
}
