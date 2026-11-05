// concern: hosted-change-pruning
/** Runs each hosted change journal's retention through its guarded record function. */

import type { SQL } from 'bun'

const rows = <T>(value: unknown) => value as T[]

export async function pruneHostedChanges(client: SQL) {
  const result = rows<{
    hub_deleted: number | bigint | string
    record_deleted: number | bigint | string
  }>(
    await client`SELECT hub_change_prune() AS hub_deleted,
      record_change_prune() AS record_deleted`,
  )[0]
  if (!result)
    throw new Error(
      'change journal pruning returned no result; verify the hub and record change migrations',
    )
  return { hub: Number(result.hub_deleted), record: Number(result.record_deleted) }
}
