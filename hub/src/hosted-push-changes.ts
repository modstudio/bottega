import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import { applyDayChangeInTransaction, applyIntervalChangeInTransaction } from './hosted-evidence.ts'
import { mirrorStatusEventRow, mirrorTaskRow, type TaskIdentity } from './hosted-tasks.ts'
import {
  HOSTED_DAY_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type HostedPushOutcome,
  type PushableHubChangeTable,
  type PushedStatusEvent,
  type PushedTask,
} from './push-contract.ts'
import { orderHostedPushChanges } from './push-order.ts'

type PushDeclaration = {
  apply(
    tx: SQL,
    identity: TaskIdentity,
    input: HostedPushChange,
  ): Promise<Extract<HostedPushOutcome, { status: 'applied' | 'duplicate' }>>
}

async function taskEquals(tx: SQL, identity: TaskIdentity, row: PushedTask) {
  const matches = (await tx`SELECT 1 FROM hub_task
    WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid
      AND project_name=${row.project_name} AND key=${row.key} AND project=${row.project}
      AND title IS NOT DISTINCT FROM ${row.title} AND status IS NOT DISTINCT FROM ${row.status}
      AND status_category IS NOT DISTINCT FROM ${row.status_category}
      AND parent_key IS NOT DISTINCT FROM ${row.parent_key}
      AND body IS NOT DISTINCT FROM ${row.body} AND assignee IS NOT DISTINCT FROM ${row.assignee}
      AND opened_at IS NOT DISTINCT FROM ${row.opened_at}::timestamptz
      AND closed_at IS NOT DISTINCT FROM ${row.closed_at}::timestamptz
      AND source=${row.source} AND updated_at=${row.updated_at}::timestamptz
      AND deleted_at IS NOT DISTINCT FROM ${row.deleted_at}::timestamptz
      AND next_document_number >= ${row.next_document_number}`) as Array<{ '?column?': 1 }>
  return matches.length > 0
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
  [HOSTED_TASK_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_TASK_TABLE)
        throw new Error(`${input.table} was routed to the task handler`)
      if (input.op === 'delete') throw new Error('hub_task does not accept delete yet')
      if (await taskEquals(tx, identity, input.row)) return { id: input.id, status: 'duplicate' }
      const adoption = await mirrorTaskRow(tx, identity, input.row)
      return {
        id: input.id,
        status: 'applied',
        ...(adoption ? { adoptedId: adoption.id } : {}),
      }
    },
  },
  [HOSTED_STATUS_EVENT_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_STATUS_EVENT_TABLE)
        throw new Error(`${input.table} was routed to the status event handler`)
      if (input.op === 'delete') throw new Error('hub_task_status_event does not accept delete yet')
      const row = input.row
      const existing = (await tx`SELECT id FROM hub_task_status_event WHERE id=${input.id}::uuid
          AND space_id=${identity.spaceId}::uuid`) as Array<{ id: string }>
      await mirrorStatusEventRow(tx, identity, row)
      if (!existing.length) return { id: input.id, status: 'applied' }
      if (!(await statusEventEquals(tx, identity, row)))
        throw new Error(`hub_task_status_event ${input.id} differs from the pushed row`)
      return { id: input.id, status: 'duplicate' }
    },
  },
  [HOSTED_INTERVAL_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_INTERVAL_TABLE)
        throw new Error(`${input.table} was routed to the interval handler`)
      const status = await applyIntervalChangeInTransaction(tx, identity, input)
      return { id: input.id, status }
    },
  },
  [HOSTED_DAY_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_DAY_TABLE)
        throw new Error(`${input.table} was routed to the day handler`)
      if (input.op === 'delete') throw new Error('hub_day does not accept delete')
      const status = await applyDayChangeInTransaction(tx, identity, input.row)
      return { id: input.id, status }
    },
  },
}

export async function applyHostedPushChangesInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  inputs: HostedPushChange[],
): Promise<HostedPushOutcome[]> {
  const positions = new Map(inputs.map((input, index) => [input.id, index]))
  const ordered = orderHostedPushChanges(inputs).map((input) => ({
    input,
    index: positions.get(input.id)!,
  }))
  const outcomes = new Array<HostedPushOutcome>(inputs.length)
  for (const { input, index } of ordered) {
    await tx.unsafe('SAVEPOINT hub_push_row')
    try {
      const outcome = await PUSHABLE_HUB_CHANGES[input.table]!.apply(tx, identity, input)
      await tx.unsafe('RELEASE SAVEPOINT hub_push_row')
      outcomes[index] = outcome
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
