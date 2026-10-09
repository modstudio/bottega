// concern: hosted-change-pruning
/** Runs the hosted change-log retention operation through its guarded record function. */

import { SQL } from 'bun'

const rows = <T>(value: unknown) => value as T[]

export async function pruneHostedChanges(databaseUrl: string, retentionDays: number) {
  const client = new SQL(databaseUrl)
  try {
    const result = rows<{ deleted: number | bigint | string }>(
      await client`SELECT hub_change_prune(${retentionDays} * interval '1 day') AS deleted`,
    )[0]
    if (!result)
      throw new Error('hub change pruning returned no result; verify the record migration')
    return Number(result.deleted)
  } finally {
    await client.close()
  }
}
