import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import { mirrorStatusEventRow, type TaskIdentity } from './hosted-tasks.ts'
import {
  type HostedPushChange,
  type HostedPushOutcome,
  PUSHABLE_HUB_CHANGE_TABLES,
  type PushableHubChangeTable,
  type PushedStatusEvent,
} from './push-contract.ts'

type PushDeclaration = {
  dependencyOrder: number
  apply(tx: SQL, identity: TaskIdentity, input: HostedPushChange): Promise<'applied' | 'duplicate'>
}

async function statusEventEquals(tx: SQL, identity: TaskIdentity, row: PushedStatusEvent) {
  const matches = (await tx`SELECT 1 FROM hub_task_status_event
    WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid
      AND project_name=${row.project_name} AND task_key=${row.task_key}
      AND at=${row.at}::timestamptz
      AND from_status IS NOT DISTINCT FROM ${row.from_status}
      AND to_status=${row.to_status}
      AND created_at=${row.created_at}::timestamptz
      AND updated_at=${row.updated_at}::timestamptz
      AND deleted_at IS NOT DISTINCT FROM ${row.deleted_at}::timestamptz`) as Array<{
    '?column?': 1
  }>
  return matches.length > 0
}

const PUSHABLE_HUB_CHANGES: Record<PushableHubChangeTable, PushDeclaration> = {
  [PUSHABLE_HUB_CHANGE_TABLES[0]]: {
    dependencyOrder: 1,
    async apply(tx, identity, input) {
      if (input.op === 'delete') throw new Error('hub_task_status_event does not accept delete yet')
      const row = input.row
      const existing = (await tx`SELECT id FROM hub_task_status_event WHERE id=${input.id}::uuid
          AND space_id=${identity.spaceId}::uuid`) as Array<{ id: string }>
      await mirrorStatusEventRow(tx, identity, row)
      if (!existing.length) return 'applied'
      if (!(await statusEventEquals(tx, identity, row)))
        throw new Error(`hub_task_status_event ${input.id} differs from the pushed row`)
      return 'duplicate'
    },
  },
}

export async function applyHostedPushChangesInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  inputs: HostedPushChange[],
): Promise<HostedPushOutcome[]> {
  const ordered = inputs
    .map((input, index) => ({ input, index }))
    .sort(
      (left, right) =>
        PUSHABLE_HUB_CHANGES[left.input.table]!.dependencyOrder -
          PUSHABLE_HUB_CHANGES[right.input.table]!.dependencyOrder || left.index - right.index,
    )
  const outcomes = new Array<HostedPushOutcome>(inputs.length)
  for (const { input, index } of ordered) {
    await tx.unsafe('SAVEPOINT hub_push_row')
    try {
      const status = await PUSHABLE_HUB_CHANGES[input.table]!.apply(tx, identity, input)
      await tx.unsafe('RELEASE SAVEPOINT hub_push_row')
      outcomes[index] = { id: input.id, status }
    } catch (error) {
      await tx.unsafe('ROLLBACK TO SAVEPOINT hub_push_row')
      await tx.unsafe('RELEASE SAVEPOINT hub_push_row')
      outcomes[index] = { id: input.id, status: 'rejected', reason: (error as Error).message }
    }
  }
  return outcomes
}

export async function applyHostedPushChanges(
  url: string,
  identity: TaskIdentity,
  inputs: HostedPushChange[],
) {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, identity)
      return applyHostedPushChangesInTransaction(tx, identity, inputs)
    })
  } finally {
    await client.close()
  }
}
