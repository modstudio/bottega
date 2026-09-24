import type { SQL } from 'bun'
import type { TenantPrincipal } from '../../shared/record/tenant.ts'
import { hostedTaskRelationships } from './hosted-task-reference.ts'
import { confirmSoftDelete, type TaskIdentity, withHostedTenant } from './hosted-tasks.ts'

export type HostedTaskPresencePair = { space_id: string; key: string }

const rows = <T>(value: unknown) => value as T[]

export async function hostedTaskPresence(
  url: string,
  identity: TaskIdentity,
  pairs: HostedTaskPresencePair[],
) {
  const allowed = new Set(identity.spaceIds ?? [identity.spaceId])
  allowed.add(identity.spaceId)
  const accepted = pairs.filter((pair) => allowed.has(pair.space_id))
  const refused = pairs
    .filter((pair) => !allowed.has(pair.space_id))
    .map((pair) => ({ ...pair, reason: 'not-a-member' as const }))
  return withHostedTenant(url, identity, async (tx) => {
    const present: HostedTaskPresencePair[] = []
    const grouped = new Map<string, HostedTaskPresencePair[]>()
    for (const pair of accepted)
      grouped.set(pair.space_id, [...(grouped.get(pair.space_id) ?? []), pair])
    for (const [spaceId, requested] of grouped) {
      const keys = [...new Set(requested.map((pair) => pair.key))]
      if (!keys.length) continue
      present.push(
        ...rows<HostedTaskPresencePair>(
          await tx`SELECT space_id::text,key FROM hub_task
            WHERE space_id=${spaceId}::uuid AND key IN ${tx(keys)} AND deleted_at IS NULL`,
        ),
      )
    }
    return { present, refused }
  })
}

async function softDeleteChildren(
  tx: SQL,
  identity: TenantPrincipal,
  taskIds: string[],
  taskKeys: string[],
) {
  const counts: Record<string, number> = {}
  for (const relationship of hostedTaskRelationships.slice(0, 3)) {
    const deleted = rows<{ id: string }>(
      await tx`UPDATE ${tx.unsafe(relationship.table)} SET deleted_at=now(),updated_at=now()
        WHERE space_id=${identity.spaceId}::uuid AND deleted_at IS NULL AND
          (${tx.unsafe(relationship.idColumn)} IN ${tx(taskIds)} OR
            (${tx.unsafe(relationship.idColumn)} IS NULL AND
             ${tx.unsafe(relationship.keyColumn)} IN ${tx(taskKeys)}))
        RETURNING id`,
    )
    counts[relationship.table] = deleted.length
  }
  return counts
}

export async function softDeleteHostedTasks(
  url: string,
  identity: TaskIdentity,
  taskIds: string[],
  confirmation?: number,
) {
  return withHostedTenant(url, identity, async (tx) => {
    if (!taskIds.length) {
      confirmSoftDelete(0, confirmation)
      return { tasks: 0, comments: 0, documents: 0, statusEvents: 0 }
    }
    const found = rows<{ id: string; key: string }>(
      await tx`SELECT id,key FROM hub_task WHERE space_id=${identity.spaceId}::uuid
        AND id IN ${tx(taskIds)} AND deleted_at IS NULL FOR UPDATE`,
    )
    confirmSoftDelete(found.length, confirmation)
    if (!found.length) return { tasks: 0, comments: 0, documents: 0, statusEvents: 0 }
    const ids = found.map((row) => row.id)
    const keys = found.map((row) => row.key)
    const children = await softDeleteChildren(tx, identity, ids, keys)
    await tx`UPDATE hub_task SET parent_id=NULL,updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND parent_id IN ${tx(ids)}`
    await tx`UPDATE hub_note SET promoted_task_id=NULL,updated_at=now()
      WHERE space_id=${identity.spaceId}::uuid AND promoted_task_id IN ${tx(ids)}`
    const tasks = rows<{ id: string }>(
      await tx`UPDATE hub_task SET deleted_at=now(),updated_at=now()
        WHERE space_id=${identity.spaceId}::uuid AND id IN ${tx(ids)} RETURNING id`,
    )
    return {
      tasks: tasks.length,
      comments: children.hub_task_comment ?? 0,
      documents: children.hub_task_document ?? 0,
      statusEvents: children.hub_task_status_event ?? 0,
    }
  })
}
