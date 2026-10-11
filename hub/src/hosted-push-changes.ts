import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import { type HostedStatusEvent, mirrorStatusEventRow, type TaskIdentity } from './hosted-tasks.ts'

type PushInput = {
  table: string
  id: string
  op: 'upsert' | 'delete'
  row?: Record<string, unknown>
}

export type HostedPushOutcome =
  | { id: string; status: 'applied' | 'duplicate' }
  | { id: string; status: 'rejected'; reason: string }

type PushDeclaration = {
  dependencyOrder: number
  apply(tx: SQL, identity: TaskIdentity, input: PushInput): Promise<'applied' | 'duplicate'>
}

export const PUSHABLE_HUB_CHANGES: Record<string, PushDeclaration> = {
  hub_task_status_event: {
    dependencyOrder: 1,
    async apply(tx, identity, input) {
      if (input.op === 'delete') throw new Error('hub_task_status_event does not accept delete yet')
      if (!input.row || input.row.id !== input.id)
        throw new Error('hub_task_status_event upsert requires a row whose id matches the pointer')
      const existing = (await tx`SELECT id FROM hub_task_status_event WHERE id=${input.id}::uuid
          AND space_id=${identity.spaceId}::uuid`) as Array<{ id: string }>
      await mirrorStatusEventRow(tx, identity, input.row as unknown as HostedStatusEvent)
      return existing.length ? 'duplicate' : 'applied'
    },
  },
}

export const PUSHABLE_HUB_CHANGE_TABLES = Object.keys(PUSHABLE_HUB_CHANGES)

export async function applyHostedPushChangesInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  inputs: PushInput[],
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
  inputs: PushInput[],
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
