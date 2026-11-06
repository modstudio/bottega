// concern: hosted-change-pruning
/** Runs the hosted change journal's retention through its guarded record function. */

import type { SQL } from 'bun'

const rows = <T>(value: unknown) => value as T[]

export async function pruneHostedChanges(client: SQL) {
  const record = rows<{ deleted: number | bigint | string }>(
    await client`SELECT record_change_prune() AS deleted`,
  )[0]
  if (!record)
    throw new Error('change journal pruning returned no result; verify the record change migration')
  return { record: Number(record.deleted) }
}
