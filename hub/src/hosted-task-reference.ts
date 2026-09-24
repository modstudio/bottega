import type { SQL } from 'bun'

export const hostedTaskRelationships = [
  { table: 'hub_task_comment', idColumn: 'task_id', keyColumn: 'task_key' },
  { table: 'hub_task_document', idColumn: 'task_id', keyColumn: 'task_key' },
  { table: 'hub_task_status_event', idColumn: 'task_id', keyColumn: 'task_key' },
  { table: 'hub_task', idColumn: 'parent_id', keyColumn: 'parent_key' },
  { table: 'hub_note', idColumn: 'promoted_task_id', keyColumn: 'promoted_task' },
] as const

export type HostedTaskRelationshipTable = (typeof hostedTaskRelationships)[number]['table']
type Relationship = (typeof hostedTaskRelationships)[number]

export function hostedTaskRelationship(table: HostedTaskRelationshipTable): Relationship {
  return hostedTaskRelationships.find((relationship) => relationship.table === table)!
}

export function hostedTaskReference(
  table: HostedTaskRelationshipTable,
  row: object,
): { id: string | null; key: string | null } {
  const relationship = hostedTaskRelationship(table)
  const values = row as Record<string, unknown>
  return {
    id: (values[relationship.idColumn] as string | null | undefined) ?? null,
    key: (values[relationship.keyColumn] as string | null | undefined) ?? null,
  }
}

export function hostedTaskJoinCondition(
  table: HostedTaskRelationshipTable,
  child: string,
  task = 't',
) {
  const relationship = hostedTaskRelationship(table)
  return (
    `(${child}.${relationship.idColumn} IS NOT NULL AND ${task}.id=${child}.${relationship.idColumn}) OR (` +
    `${child}.${relationship.idColumn} IS NULL AND ${task}.space_id=${child}.space_id AND ` +
    `${task}.key=${child}.${relationship.keyColumn})`
  )
}

export function hostedTaskJoin(
  tx: SQL,
  table: HostedTaskRelationshipTable,
  child: string,
  task = 't',
) {
  return tx.unsafe(hostedTaskJoinCondition(table, child, task))
}

export async function taskIdFor(
  tx: SQL,
  spaceId: string,
  key: string | null,
  preferred?: string | null,
) {
  if (preferred) {
    const selected = (await tx`
      SELECT id FROM hub_task WHERE id=${preferred}::uuid AND space_id=${spaceId}::uuid
    `) as Array<{ id: string }>
    if (selected[0]) return selected[0].id
  }
  if (!key) return null
  const selected = (await tx`
    SELECT id FROM hub_task WHERE space_id=${spaceId}::uuid AND key=${key}
  `) as Array<{ id: string }>
  return selected[0]?.id ?? null
}

export function childTaskLabelUpdate(previousKey: string, nextKey: string) {
  return previousKey === nextKey ? null : { previousKey, nextKey }
}

export async function repairHostedTaskReferences(
  tx: SQL,
  spaceId: string,
  taskId: string,
  previousKey: string,
  nextKey: string,
  updatedAt: string,
) {
  const labelUpdate = childTaskLabelUpdate(previousKey, nextKey)
  if (!labelUpdate) return
  for (const relationship of hostedTaskRelationships) {
    const excludeTask = relationship.table === 'hub_task' ? tx`AND id<>${taskId}::uuid` : tx``
    await tx`UPDATE ${tx.unsafe(relationship.table)}
      SET ${tx.unsafe(relationship.keyColumn)}=${labelUpdate.nextKey},
        ${tx.unsafe(relationship.idColumn)}=${taskId}::uuid,
        updated_at=GREATEST(updated_at,${updatedAt}::timestamptz)
      WHERE space_id=${spaceId}::uuid ${excludeTask}
        AND (${tx.unsafe(relationship.idColumn)}=${taskId}::uuid OR
          (${tx.unsafe(relationship.idColumn)} IS NULL AND
           ${tx.unsafe(relationship.keyColumn)}=${labelUpdate.previousKey}))`
  }
}
