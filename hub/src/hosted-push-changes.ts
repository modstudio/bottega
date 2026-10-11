import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import { applyDayChangeInTransaction, applyIntervalChangeInTransaction } from './hosted-evidence.ts'
import {
  mirrorCommentRow,
  mirrorDocumentRow,
  mirrorStatusEventRow,
  mirrorTaskRow,
  type TaskIdentity,
} from './hosted-tasks.ts'
import {
  HOSTED_DAY_TABLE,
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
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
import { taskIdFor } from './hosted-task-reference.ts'

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

async function applyTaskFields(
  tx: SQL,
  identity: TaskIdentity,
  input: Extract<HostedPushChange, { table: typeof HOSTED_TASK_TABLE; op: 'upsert' }>,
) {
  const fields = new Set(input.fields ?? [])
  const row = input.row
  const current =
    (await tx`SELECT id FROM hub_task WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid`) as Array<{
      id: string
    }>
  if (!current.length || input.fields == null) return mirrorTaskRow(tx, identity, row)
  const parentId = fields.has('parent_key')
    ? await taskIdFor(tx, identity.spaceId, row.parent_key, row.parent_id)
    : null
  const changesStatus = fields.has('status') || fields.has('status_category')
  await tx`UPDATE hub_task SET
    project_name=CASE WHEN ${fields.has('project_name')} THEN ${row.project_name} ELSE project_name END,
    key=CASE WHEN ${fields.has('key')} THEN ${row.key} ELSE key END,
    project=CASE WHEN ${fields.has('project')} THEN ${row.project} ELSE project END,
    title=CASE WHEN ${fields.has('title')} THEN ${row.title} ELSE title END,
    status=CASE WHEN ${fields.has('status')} THEN ${row.status} ELSE status END,
    status_category=CASE WHEN ${fields.has('status_category')} THEN ${row.status_category} ELSE status_category END,
    parent_key=CASE WHEN ${fields.has('parent_key')} THEN ${row.parent_key} ELSE parent_key END,
    parent_id=CASE WHEN ${fields.has('parent_key') || fields.has('parent_id')} THEN ${parentId}::uuid ELSE parent_id END,
    body=CASE WHEN ${fields.has('body')} THEN ${row.body} ELSE body END,
    assignee=CASE WHEN ${fields.has('assignee')} THEN ${row.assignee} ELSE assignee END,
    opened_at=CASE WHEN ${fields.has('opened_at')} THEN ${row.opened_at}::timestamptz ELSE opened_at END,
    source=CASE WHEN ${fields.has('source')} THEN ${row.source} ELSE source END,
    deleted_at=CASE WHEN ${fields.has('deleted_at')} THEN ${row.deleted_at}::timestamptz ELSE deleted_at END,
    next_document_number=CASE WHEN ${fields.has('next_document_number')} THEN GREATEST(next_document_number,${row.next_document_number}) ELSE next_document_number END,
    closed_at=CASE WHEN ${changesStatus} THEN CASE WHEN ${row.status_category}='done' THEN COALESCE(closed_at,${row.updated_at}::timestamptz) ELSE NULL END ELSE closed_at END,
    updated_at=${row.updated_at}::timestamptz,last_seen=${row.updated_at}::timestamptz
    WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid`
  return null
}

async function commentEquals(
  tx: SQL,
  identity: TaskIdentity,
  row: import('./hosted-tasks.ts').HostedComment,
) {
  const found =
    await tx`SELECT 1 FROM hub_task_comment WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid AND task_key=${row.task_key} AND body=${row.body} AND updated_at=${row.updated_at}::timestamptz AND deleted_at IS NOT DISTINCT FROM ${row.deleted_at}::timestamptz`
  return (found as unknown[]).length > 0
}

async function documentEquals(
  tx: SQL,
  identity: TaskIdentity,
  row: import('./hosted-tasks.ts').HostedDocument,
) {
  const found =
    await tx`SELECT 1 FROM hub_task_document WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid AND task_key=${row.task_key} AND number IS NOT DISTINCT FROM ${row.number} AND role IS NOT DISTINCT FROM ${row.role} AND title=${row.title} AND body=${row.body} AND version=${row.version} AND updated_at=${row.updated_at}::timestamptz AND deleted_at IS NOT DISTINCT FROM ${row.deleted_at}::timestamptz`
  return (found as unknown[]).length > 0
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
      const adoption = await applyTaskFields(tx, identity, input)
      return {
        id: input.id,
        status: 'applied',
        ...(adoption ? { adoptedId: adoption.id } : {}),
      }
    },
  },
  [HOSTED_COMMENT_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_COMMENT_TABLE || input.op === 'delete')
        throw new Error('hub_task_comment accepts upsert only')
      if (await commentEquals(tx, identity, input.row)) return { id: input.id, status: 'duplicate' }
      await mirrorCommentRow(tx, identity, input.row)
      await tx`UPDATE hub_task SET updated_at=GREATEST(updated_at,${input.row.updated_at}::timestamptz),last_seen=GREATEST(last_seen,${input.row.updated_at}::timestamptz) WHERE id=${input.row.task_id ?? null}::uuid AND space_id=${identity.spaceId}::uuid`
      return { id: input.id, status: 'applied' }
    },
  },
  [HOSTED_DOCUMENT_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_DOCUMENT_TABLE) throw new Error('wrong document handler')
      const existing =
        (await tx`SELECT deleted_at FROM hub_task_document WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`) as Array<{
          deleted_at: string | null
        }>
      if (input.op === 'delete') {
        if (!existing.length || existing[0]!.deleted_at)
          return { id: input.id, status: 'duplicate' }
        await tx`UPDATE hub_task_document SET deleted_at=now(),updated_at=now() WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`
        return { id: input.id, status: 'applied' }
      }
      if (await documentEquals(tx, identity, input.row))
        return { id: input.id, status: 'duplicate' }
      if (existing.length && input.fields != null) {
        const fields = new Set(input.fields)
        const row = input.row
        await tx`UPDATE hub_task_document SET
          task_key=CASE WHEN ${fields.has('task_key')} THEN ${row.task_key} ELSE task_key END,
          number=CASE WHEN ${fields.has('number')} THEN ${row.number} ELSE number END,
          role=CASE WHEN ${fields.has('role')} THEN ${row.role} ELSE role END,
          title=CASE WHEN ${fields.has('title')} THEN ${row.title} ELSE title END,
          body=CASE WHEN ${fields.has('body')} THEN ${row.body} ELSE body END,
          version=CASE WHEN ${fields.has('version')} THEN ${row.version} ELSE version END,
          deleted_at=CASE WHEN ${fields.has('deleted_at')} THEN ${row.deleted_at}::timestamptz ELSE deleted_at END,
          updated_at=${row.updated_at}::timestamptz
          WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid`
      } else await mirrorDocumentRow(tx, identity, input.row)
      return { id: input.id, status: 'applied' }
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
