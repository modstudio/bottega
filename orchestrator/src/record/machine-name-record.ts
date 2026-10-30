// concern: machine-name-record
/** Atomically claims and updates hosted machine names. Must not know CLI presentation. */
import { SQL } from 'bun'
import {
  decideMachineNameClaim,
  displayNameRefusal,
  shortNameRefusal,
} from '../../../shared/machine-name.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordPrincipal } from './record-sync-contract.ts'
import {
  RecordSyncRequestRefusal,
  recordSyncMachineOwnershipDecision,
} from './record-sync-decision.ts'
import { bindPrincipal } from './record-sync-principal.ts'

function writableSpaces(identity: RecordIdentity): string[] {
  return identity.memberships
    .filter((row) => String(row.permission) === 'write')
    .map((row) => String(row.space_id))
}

async function claimInSpace(
  tx: SQL,
  input: { userId: string; spaceId: string; machineId: string; shortName: string; now: string },
): Promise<void> {
  await bindPrincipal(tx, { userId: input.userId, spaceId: input.spaceId })
  const rows = await tx`
    SELECT c.machine_id,c.short_name,coalesce(m.display_name,m.name) AS display_name,m.retired_at
    FROM machine_name_claim c
    JOIN machine m ON m.id=c.machine_id WHERE c.space_id=${input.spaceId}::uuid
  `
  const decision = decideMachineNameClaim(
    rows.map((row: Record<string, unknown>) => ({
      machineId: String(row.machine_id),
      shortName: String(row.short_name),
      displayName: String(row.display_name),
      retired: row.retired_at != null,
    })),
    input.machineId,
    input.shortName,
  )
  if (decision.status === 'refused') throw new RecordSyncRequestRefusal(decision.reason)
  if (decision.status === 'claim') {
    const inserted = await tx`
      INSERT INTO machine_name_claim (id,space_id,short_name,machine_id,claimed_at)
      VALUES (${Bun.randomUUIDv7()}::uuid,${input.spaceId}::uuid,${input.shortName},${input.machineId}::uuid,${input.now}::timestamptz)
      ON CONFLICT (space_id,short_name) DO NOTHING RETURNING machine_id
    `
    if (inserted.length === 0) {
      const holder = await tx`
        SELECT c.machine_id,c.short_name,coalesce(m.display_name,m.name) AS display_name,m.retired_at
        FROM machine_name_claim c
        JOIN machine m ON m.id=c.machine_id
        WHERE c.space_id=${input.spaceId}::uuid AND c.short_name=${input.shortName}
      `
      const raced = decideMachineNameClaim(
        holder.map((row: Record<string, unknown>) => ({
          machineId: String(row.machine_id),
          shortName: String(row.short_name),
          displayName: String(row.display_name),
          retired: row.retired_at != null,
        })),
        input.machineId,
        input.shortName,
      )
      if (raced.status === 'refused') throw new RecordSyncRequestRefusal(raced.reason)
    }
  }
}

export async function upsertHostedMachine(
  postgres: SQL,
  seenAt: string,
  identity: { id: string; shortName?: string; displayName?: string; name?: string },
  principal: RecordPrincipal,
): Promise<void> {
  const shortName = identity.shortName ?? identity.name
  const displayName = identity.displayName ?? identity.name
  if (!shortName || !displayName) throw new Error('machine sync requires short and display names')
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const owned = await tx`
      INSERT INTO machine (id,user_id,name,registered_at,last_seen)
      VALUES (${identity.id}::uuid,${principal.userId}::uuid,${displayName},${seenAt}::timestamptz,
        ${seenAt}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET last_seen=excluded.last_seen
      WHERE machine.user_id=excluded.user_id RETURNING user_id
    `
    if (owned.length > 0) return
    const owners = await tx`SELECT user_id FROM machine WHERE id=${identity.id}::uuid`
    const decision = recordSyncMachineOwnershipDecision(
      identity.id,
      owners[0]?.user_id == null ? null : String(owners[0].user_id),
      principal.userId,
    )
    if (decision.status === 'refused') throw new RecordSyncRequestRefusal(decision.reason)
    throw new Error(`machine ownership changed while registering ${identity.id}`)
  })
  await postgres.begin(async (tx) => {
    await claimInSpace(tx, {
      userId: principal.userId,
      spaceId: principal.spaceId,
      machineId: identity.id,
      shortName,
      now: seenAt,
    })
    await tx`
      UPDATE machine SET name=${displayName},short_name=${shortName},display_name=${displayName}
      WHERE id=${identity.id}::uuid AND user_id=${principal.userId}::uuid
    `
  })
}

export async function renameHostedMachine(input: {
  url: string
  identity: RecordIdentity
  machineId: string
  shortName?: string
  displayName?: string
  now?: string
}): Promise<void> {
  if (!input.shortName && !input.displayName)
    throw new Error('rename requires --short-name or --display-name')
  if (input.shortName) {
    const refusal = shortNameRefusal(input.shortName)
    if (refusal) throw new Error(refusal)
  }
  if (input.displayName) {
    const refusal = displayNameRefusal(input.displayName)
    if (refusal) throw new Error(refusal)
  }
  const postgres = new SQL(input.url)
  try {
    await postgres.begin(async (tx) => {
      const owned =
        await tx`SELECT short_name,display_name FROM machine WHERE id=${input.machineId}::uuid AND user_id=${input.identity.user.id}::uuid FOR UPDATE`
      if (!owned.length)
        throw new Error(`machine ${input.machineId} is not registered to the signed-in user`)
      const shortName = input.shortName ?? String(owned[0]!.short_name)
      const displayName = input.displayName ?? String(owned[0]!.display_name)
      if (input.shortName) {
        for (const spaceId of writableSpaces(input.identity)) {
          await claimInSpace(tx, {
            userId: input.identity.user.id,
            spaceId,
            machineId: input.machineId,
            shortName,
            now: input.now ?? new Date().toISOString(),
          })
        }
      }
      await tx`UPDATE machine SET short_name=${shortName},display_name=${displayName},name=${displayName} WHERE id=${input.machineId}::uuid AND user_id=${input.identity.user.id}::uuid`
    })
  } finally {
    await postgres.close()
  }
}

export async function retireHostedMachine(input: {
  url: string
  identity: RecordIdentity
  shortName: string
  now?: string
}): Promise<string> {
  const postgres = new SQL(input.url)
  try {
    return await postgres.begin(async (tx) => {
      const ids = new Set<string>()
      for (const spaceId of writableSpaces(input.identity)) {
        await bindPrincipal(tx, { userId: input.identity.user.id, spaceId })
        const rows = await tx`
          SELECT m.id FROM machine m JOIN machine_name_claim c ON c.machine_id=m.id
          WHERE m.user_id=${input.identity.user.id}::uuid AND c.short_name=${input.shortName}
            AND c.space_id=${spaceId}::uuid
        `
        for (const row of rows) ids.add(String(row.id))
      }
      if (ids.size !== 1)
        throw new Error(`no unique joined machine has short name ${input.shortName}`)
      const id = [...ids][0]!
      await tx`UPDATE machine SET retired_at=${input.now ?? new Date().toISOString()}::timestamptz WHERE id=${id}::uuid AND user_id=${input.identity.user.id}::uuid`
      return id
    })
  } finally {
    await postgres.close()
  }
}
