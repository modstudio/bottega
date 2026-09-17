// concern: record-snapshots
/** Owns tenant-bound latest orchestrator snapshots. Must not know HTTP or local commands. */
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'

export const SNAPSHOT_KINDS = ['state', 'blockers', 'health', 'jobs', 'agents'] as const
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number]
type Tenant = { url: string; userId: string; spaceId: string }

export type RecordSnapshot = {
  id: string
  kind: SnapshotKind
  machineId: string
  payload: unknown
  takenAt: string
}

async function tenant<T>(input: Tenant, work: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
      await tx`SELECT set_config('app.space_id', ${input.spaceId}, true)`
      return work(tx)
    })
  } finally {
    await client.close()
  }
}

export async function upsertRecordSnapshot(
  input: Tenant & { kind: SnapshotKind; machineId: string; payload: unknown },
): Promise<{ takenAt: string }> {
  return tenant(input, async (tx) => {
    const takenAt = new Date().toISOString()
    const rows = await tx`
      INSERT INTO orch_snapshot (id, space_id, kind, machine_id, payload, taken_at)
      VALUES (
        ${newRecordId()}::uuid, ${input.spaceId}::uuid, ${input.kind},
        ${input.machineId}::uuid, ${JSON.stringify(input.payload)}::text::jsonb,
        ${takenAt}::timestamptz
      )
      ON CONFLICT (space_id, kind, machine_id) DO UPDATE SET
        payload=excluded.payload, taken_at=excluded.taken_at
      RETURNING taken_at
    `
    return { takenAt: new Date(String(rows[0]!.taken_at)).toISOString() }
  })
}

export async function listRecordSnapshots(input: Tenant): Promise<RecordSnapshot[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT id, kind, machine_id, payload, taken_at
      FROM orch_snapshot
      WHERE space_id=${input.spaceId}::uuid
      ORDER BY kind, machine_id
    `
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      kind: String(row.kind) as SnapshotKind,
      machineId: String(row.machine_id),
      payload: row.payload,
      takenAt: new Date(String(row.taken_at)).toISOString(),
    }))
  })
}
