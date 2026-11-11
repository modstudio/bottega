// concern: record-no-destination-write-store
/** Persists and summarizes destination-less write telemetry under record tenancy. */

import type { SQL } from 'bun'
import { newRecordId } from './record/schema.ts'
import { bindTenant, type TenantPrincipal } from './record/tenant.ts'
import type {
  NoDestinationWrite,
  NoDestinationWriteStoreReport,
} from './record-no-destination-write-contract.ts'

const rows = <T>(value: unknown) => value as T[]

export async function recordNoDestinationWrite(
  client: SQL,
  principal: TenantPrincipal,
  decision: NoDestinationWrite,
): Promise<void> {
  await client.begin(async (tx) => {
    await bindTenant(tx, principal)
    await tx`INSERT INTO no_destination_write (id, space_id, route, cause, at, created_at)
      VALUES (${newRecordId()}, ${decision.spaceId}, ${decision.route}, ${decision.cause}, now(), now())`
  })
}

export async function readNoDestinationWrites(
  client: SQL,
  principal: TenantPrincipal,
): Promise<NoDestinationWriteStoreReport> {
  return client.begin(async (tx) => {
    await bindTenant(tx, principal)
    const window = rows<{ windowStart: Date }>(
      await tx`SELECT now() - interval '14 days' AS "windowStart"`,
    )[0]
    if (!window) throw new Error('destination-less write telemetry returned no retention window')
    const counts = rows<{
      spaceId: string
      route: string
      cause: string
      occurrences: number | bigint | string
      lastAt: Date
    }>(
      await tx`SELECT space_id AS "spaceId", route, cause, count(*) AS occurrences, max(at) AS "lastAt"
        FROM no_destination_write
        WHERE at >= ${window.windowStart}
        GROUP BY space_id, route, cause
        ORDER BY space_id, route, cause`,
    ).map((row) => ({
      ...row,
      occurrences: Number(row.occurrences),
      lastAt: row.lastAt.toISOString(),
    }))
    return { windowStart: window.windowStart.toISOString(), counts }
  })
}
