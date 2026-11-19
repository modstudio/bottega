// concern: sealed-secret-write-verification
/** Proves a sealed secret write is visible through its destination before success is reported. */
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigScope,
  type ConfigWriteDestination,
} from '../../../shared/config-client.ts'

export type ExpectedSecret = {
  key: string
  scope: ConfigScope
  environment: string
  rowVersion: number
  dekId: string
}

type WrittenSecretRow = Pick<
  Awaited<ReturnType<ConfigClient['getSecret']>>,
  'key' | 'scope' | 'environment' | 'rowVersion' | 'dekId'
>

/** Decide whether the read-back is the exact row the write reported. */
export function isWrittenSecretRow(
  read: WrittenSecretRow | null | undefined,
  expected: ExpectedSecret,
): boolean {
  return (
    read?.key === expected.key &&
    read.scope === expected.scope &&
    read.environment === expected.environment &&
    read.rowVersion === expected.rowVersion &&
    read.dekId === expected.dekId
  )
}

export async function verifySecretWrite(
  client: ConfigClient,
  expected: ExpectedSecret,
  destination: ConfigWriteDestination,
  remedy: string,
): Promise<void> {
  let read = null
  try {
    read = await client.getSecret(expected.key, expected.scope, expected.environment, destination)
  } catch (error) {
    if (!(error instanceof ConfigClientError && error.status === 404)) throw error
  }
  if (isWrittenSecretRow(read, expected)) return
  const binding = destination.projectId
    ? `project ${destination.projectId} in space ${destination.destinationSpaceId}`
    : `space ${destination.destinationSpaceId}`
  throw new Error(
    `refusing sealed secret success: wrote ${expected.key} in ${binding} but could not read that row back from ${binding}; verify record access, then retry \`${remedy}\``,
  )
}
