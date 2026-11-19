// concern: sealed-secret-write-verification
/** Proves a sealed secret write is visible through its destination before success is reported. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigScope,
  type ConfigWriteDestination,
} from '../../../shared/config-client.ts'

type ExpectedSecret = {
  key: string
  scope: ConfigScope
  environment: string
  rowVersion: number
  dekId: string
}

export async function verifySecretWrite(
  client: ConfigClient,
  expected: ExpectedSecret,
  destination: ConfigWriteDestination,
): Promise<void> {
  let read = null
  try {
    read = await client.getSecret(expected.key, expected.scope, expected.environment, destination)
  } catch (error) {
    if (!(error instanceof ConfigClientError && error.status === 404)) throw error
  }
  if (
    read?.key === expected.key &&
    read.scope === expected.scope &&
    read.environment === expected.environment &&
    read.rowVersion === expected.rowVersion &&
    read.dekId === expected.dekId
  )
    return
  throw new Error(
    `refusing sealed secret success: wrote ${expected.key} in space ${destination.destinationSpaceId} but could not read that row back from space ${destination.destinationSpaceId}; verify record access, then retry \`${PLATFORM_SLUG} machine config secret set ${expected.key}\``,
  )
}
