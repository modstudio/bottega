// concern: config-write-verification
/** Proves a plain configuration write is visible through its destination before success is reported. */
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigEntry,
  type ConfigWriteDestination,
} from '../../../shared/config-client.ts'

type WrittenConfigRow = Pick<ConfigEntry, 'value' | 'rowVersion'>

/** Decide whether the read-back has the value and version reported by the write. */
export function isWrittenConfigRow(
  read: WrittenConfigRow | null | undefined,
  expected: WrittenConfigRow,
): boolean {
  return read?.value === expected.value && read.rowVersion === expected.rowVersion
}

export async function verifyConfigWrite(
  client: ConfigClient,
  expected: ConfigEntry,
  destination: ConfigWriteDestination,
  remedy: string,
): Promise<void> {
  let read = null
  try {
    read = await client.getEntry(expected.key, expected.scope, expected.environment, destination)
  } catch (error) {
    if (!(error instanceof ConfigClientError && error.status === 404)) throw error
  }
  if (isWrittenConfigRow(read, expected)) return
  throw new Error(
    `refusing config write success: wrote ${expected.key} in space ${destination.destinationSpaceId} but could not read that row back from space ${destination.destinationSpaceId}; verify record access, then retry \`${remedy}\``,
  )
}
