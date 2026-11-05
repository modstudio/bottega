// concern: hosted-change-pruning
/** Runs each hosted change journal's retention through its guarded record function. */

import type { SQL } from 'bun'

const rows = <T>(value: unknown) => value as T[]

// Each journal prunes in its own statement, so hub retention commits even when the hub binary
// runs before the record migration that adds record_change_prune.
export async function pruneHostedChanges(client: SQL) {
  const hub = rows<{ deleted: number | bigint | string }>(
    await client`SELECT hub_change_prune() AS deleted`,
  )[0]
  const record = rows<{ deleted: number | bigint | string }>(
    await client`SELECT record_change_prune() AS deleted`,
  )[0]
  if (!hub || !record)
    throw new Error(
      'change journal pruning returned no result; verify the hub and record change migrations',
    )
  return { hub: Number(hub.deleted), record: Number(record.deleted) }
}
