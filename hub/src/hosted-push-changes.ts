import type { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { applyDayChangeInTransaction, applyIntervalChangeInTransaction } from './hosted-evidence.ts'
import { storedHubProjectId } from './hosted-project-identity.ts'
import {
  decideDocumentUpsert,
  decideNoteAcknowledgementUpsert,
  decideNoteUpsert,
  decideTaskUpsert,
} from './hosted-push-decision.ts'
import { taskIdFor } from './hosted-task-reference.ts'
import {
  mirrorCommentRow,
  mirrorDocumentRow,
  mirrorStatusEventRow,
  mirrorTaskRow,
  type TaskIdentity,
} from './hosted-tasks.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DAY_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
  type HostedPushOutcome,
  type PushableHubChangeTable,
  type PushedComment,
  type PushedDocument,
  type PushedNote,
  type PushedNoteAcknowledgement,
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

async function requireLiveChildTask(
  tx: SQL,
  identity: TaskIdentity,
  row: PushedComment | PushedDocument,
): Promise<void> {
  const found = row.task_id
    ? ((await tx`SELECT id,deleted_at FROM hub_task WHERE space_id=${identity.spaceId}::uuid
        AND id=${row.task_id}::uuid AND key=${row.task_key} AND project_name=${row.project_name}`) as Array<{
        id: string
        deleted_at: string | null
      }>)
    : []
  if (found[0]?.deleted_at) throw new Error(DELETED_ON_HOSTED_RECORD_REASON)
  if (!found[0])
    throw new Error(
      `no live hosted task matches task_id ${row.task_id ?? 'null'}, key ${row.task_key}, and project ${row.project_name}`,
    )
}

async function applyTaskPatch(
  tx: SQL,
  identity: TaskIdentity,
  id: string,
  values: Partial<PushedTask>,
  resolveParent?: { key: string | null; preferred: string | null },
) {
  const has = (field: keyof PushedTask) => Object.hasOwn(values, field)
  const parentId = resolveParent
    ? await taskIdFor(tx, identity.spaceId, resolveParent.key, resolveParent.preferred)
    : null
  await tx`UPDATE hub_task SET
    title=CASE WHEN ${has('title')} THEN ${values.title ?? null} ELSE title END,
    status=CASE WHEN ${has('status')} THEN ${values.status ?? null} ELSE status END,
    status_category=CASE WHEN ${has('status_category')} THEN ${values.status_category ?? null} ELSE status_category END,
    parent_key=CASE WHEN ${has('parent_key')} THEN ${values.parent_key ?? null} ELSE parent_key END,
    parent_id=CASE WHEN ${Boolean(resolveParent)} THEN ${parentId}::uuid ELSE parent_id END,
    body=CASE WHEN ${has('body')} THEN ${values.body ?? null} ELSE body END,
    assignee=CASE WHEN ${has('assignee')} THEN ${values.assignee ?? null} ELSE assignee END,
    closed_at=CASE WHEN ${has('closed_at')} THEN ${values.closed_at ?? null}::timestamptz ELSE closed_at END,
    updated_at=${values.updated_at!}::timestamptz,last_seen=${values.last_seen!}::timestamptz
    WHERE id=${id}::uuid AND space_id=${identity.spaceId}::uuid`
}

type StoredCommentPushRow = PushedComment & { actor_user_id: string | null }
export type HostedCommentPushDecision =
  | { kind: 'apply' }
  | { kind: 'duplicate' }
  | { kind: 'reject'; reason: string }

const sameTimestamp = (left: string | Date | null, right: string | Date | null) =>
  left === null || right === null
    ? left === right
    : new Date(left).getTime() === new Date(right).getTime()

const commentPushMatches = (stored: StoredCommentPushRow, pushed: PushedComment) =>
  stored.id === pushed.id &&
  stored.task_key === pushed.task_key &&
  stored.body === pushed.body &&
  sameTimestamp(stored.updated_at, pushed.updated_at) &&
  sameTimestamp(stored.deleted_at, pushed.deleted_at) &&
  (pushed.actor_user_id == null || stored.actor_user_id === pushed.actor_user_id) &&
  (pushed.actor_name == null || stored.actor_name === pushed.actor_name) &&
  (pushed.agent == null || stored.agent === pushed.agent) &&
  (pushed.run_id == null || stored.run_id === pushed.run_id)

const commentPushChangesAttribution = (stored: StoredCommentPushRow, pushed: PushedComment) =>
  (pushed.actor_user_id != null && stored.actor_user_id !== pushed.actor_user_id) ||
  (pushed.actor_name != null && stored.actor_name !== pushed.actor_name) ||
  (pushed.agent != null && stored.agent !== pushed.agent) ||
  (pushed.run_id != null && stored.run_id !== pushed.run_id)

export function decideHostedCommentPush(
  stored: StoredCommentPushRow | null,
  pushed: PushedComment,
  pushingUserId: string,
): HostedCommentPushDecision {
  if (!stored) {
    if (
      pushed.actor_user_id !== null &&
      pushed.actor_user_id !== undefined &&
      pushed.actor_user_id !== pushingUserId
    )
      return { kind: 'reject', reason: 'new comment claims another member as its author' }
    return { kind: 'apply' }
  }
  if (stored.deleted_at !== null) {
    if (pushed.deleted_at !== null) return { kind: 'duplicate' }
    return { kind: 'reject', reason: DELETED_ON_HOSTED_RECORD_REASON }
  }
  if (commentPushMatches(stored, pushed)) return { kind: 'duplicate' }
  if (stored.actor_user_id === null)
    return { kind: 'reject', reason: 'comment predates recorded authorship and cannot be changed' }
  if (stored.actor_user_id !== pushingUserId)
    return { kind: 'reject', reason: 'comment belongs to another author' }
  if (commentPushChangesAttribution(stored, pushed))
    return { kind: 'reject', reason: 'comment attribution differs from the stored row' }
  return { kind: 'apply' }
}

async function statusEventEquals(tx: SQL, identity: TaskIdentity, row: PushedStatusEvent) {
  const matches = (await tx`SELECT 1 FROM hub_task_status_event
    WHERE id=${row.id}::uuid AND space_id=${identity.spaceId}::uuid
      AND project_name=${row.project_name} AND task_key=${row.task_key}
      AND at=${row.at}::timestamptz
      AND from_status IS NOT DISTINCT FROM ${row.from_status}
      AND to_status=${row.to_status}
      AND actor_user_id IS NOT DISTINCT FROM COALESCE(${row.actor_user_id},actor_user_id)
      AND actor_name IS NOT DISTINCT FROM COALESCE(${row.actor_name},actor_name)
      AND agent IS NOT DISTINCT FROM COALESCE(${row.agent},agent)
      AND run_id IS NOT DISTINCT FROM COALESCE(${row.run_id},run_id)
      AND created_at=${row.created_at}::timestamptz
      AND updated_at=${row.updated_at}::timestamptz
      AND deleted_at IS NOT DISTINCT FROM ${row.deleted_at}::timestamptz`) as Array<{
    '?column?': 1
  }>
  return matches.length > 0
}

type NotePushChange = Extract<HostedPushChange, { table: typeof HOSTED_NOTE_TABLE }>

async function deleteHostedNoteFromPush(
  tx: SQL,
  identity: TaskIdentity,
  input: Extract<NotePushChange, { op: 'delete' }>,
  current: PushedNote | undefined,
) {
  if (!current || current.deleted_at) return { id: input.id, status: 'duplicate' as const }
  await tx`UPDATE hub_note SET deleted_at=now(),updated_at=now()
    WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`
  await tx`UPDATE hub_note_acknowledgement SET deleted_at=now(),updated_at=now()
    WHERE note_id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid AND deleted_at IS NULL`
  return { id: input.id, status: 'applied' as const }
}

async function upsertHostedNoteFromPush(
  tx: SQL,
  identity: TaskIdentity,
  input: Extract<NotePushChange, { op: 'upsert' }>,
  current: PushedNote | undefined,
) {
  if (!current) throw new Error(`no live hosted note matches ${input.id}`)
  const decision = decideNoteUpsert(current, input.row, input.fields)
  if (decision.kind === 'reject') throw new Error(decision.reason)
  if (decision.kind === 'duplicate') return { id: input.id, status: 'duplicate' as const }
  if (decision.kind !== 'patch') throw new Error('an existing note must produce a patch')
  const values = decision.values
  await tx`UPDATE hub_note SET anchors=${values.anchors!},sightings=${values.sightings!},
    last_seen_at=${values.last_seen_at!}::timestamptz,stale_at=${values.stale_at ?? null}::timestamptz,
    stale_reason=${values.stale_reason ?? null},updated_at=now()
    WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`
  return { id: input.id, status: 'applied' as const }
}

async function applyHostedNotePush(tx: SQL, identity: TaskIdentity, input: NotePushChange) {
  const existing = (await tx`SELECT *,number::int number FROM hub_note
    WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid FOR UPDATE`) as PushedNote[]
  return input.op === 'delete'
    ? deleteHostedNoteFromPush(tx, identity, input, existing[0])
    : upsertHostedNoteFromPush(tx, identity, input, existing[0])
}

const PUSHABLE_HUB_CHANGES: Record<PushableHubChangeTable, PushDeclaration> = {
  [HOSTED_TASK_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_TASK_TABLE)
        throw new Error(`${input.table} was routed to the task handler`)
      if (input.op === 'delete') throw new Error('hub_task does not accept delete yet')
      const existing =
        (await tx`SELECT * FROM hub_task WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`) as PushedTask[]
      const decision = decideTaskUpsert(existing[0] ?? null, input.row, input.fields ?? null)
      if (decision.kind === 'reject') throw new Error(decision.reason)
      if (decision.kind === 'duplicate') return { id: input.id, status: 'duplicate' }
      let adoption: Awaited<ReturnType<typeof mirrorTaskRow>> = null
      if (decision.kind === 'patch')
        await applyTaskPatch(tx, identity, input.id, decision.values, decision.resolveParent)
      else adoption = await mirrorTaskRow(tx, identity, input.row)
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
      const existing = (await tx`SELECT id::text id,task_key,body,created_at,updated_at,deleted_at,
          actor_user_id,actor_name,agent,run_id,project_name,task_id::text task_id
          FROM hub_task_comment WHERE id=${input.id}::uuid
            AND space_id=${identity.spaceId}::uuid FOR UPDATE`) as StoredCommentPushRow[]
      const decision = decideHostedCommentPush(existing[0] ?? null, input.row, identity.userId)
      if (decision.kind === 'reject') throw new Error(decision.reason)
      if (decision.kind === 'duplicate') return { id: input.id, status: 'duplicate' }
      await requireLiveChildTask(tx, identity, input.row)
      await mirrorCommentRow(tx, identity, input.row)
      const taskId = await taskIdFor(tx, identity.spaceId, input.row.task_key, input.row.task_id)
      await tx`UPDATE hub_task SET updated_at=GREATEST(updated_at,${input.row.updated_at}::timestamptz),last_seen=GREATEST(last_seen,${input.row.updated_at}::timestamptz) WHERE id=${taskId}::uuid AND space_id=${identity.spaceId}::uuid`
      return { id: input.id, status: 'applied' }
    },
  },
  [HOSTED_DOCUMENT_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_DOCUMENT_TABLE) throw new Error('wrong document handler')
      const existing =
        (await tx`SELECT * FROM hub_task_document WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`) as PushedDocument[]
      if (input.op === 'delete') {
        if (!existing.length || existing[0]!.deleted_at)
          return { id: input.id, status: 'duplicate' }
        await tx`UPDATE hub_task_document SET deleted_at=now(),updated_at=now() WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`
        return { id: input.id, status: 'applied' }
      }
      await requireLiveChildTask(tx, identity, input.row)
      const decision = decideDocumentUpsert(existing[0] ?? null, input.row, input.fields ?? null)
      if (decision.kind === 'reject') throw new Error(decision.reason)
      if (decision.kind === 'duplicate') return { id: input.id, status: 'duplicate' }
      if (decision.kind === 'patch') {
        const values = decision.values
        const has = (field: keyof PushedDocument) => Object.hasOwn(values, field)
        await tx`UPDATE hub_task_document SET
          role=CASE WHEN ${has('role')} THEN ${values.role ?? null} ELSE role END,
          title=CASE WHEN ${has('title')} THEN ${values.title ?? ''} ELSE title END,
          body=CASE WHEN ${has('body')} THEN ${values.body ?? ''} ELSE body END,
          version=CASE WHEN ${has('version')} THEN ${values.version ?? ''} ELSE version END,
          updated_at=${values.updated_at!}::timestamptz
          WHERE id=${input.id}::uuid AND space_id=${identity.spaceId}::uuid`
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
      if (existing.length) {
        if (!(await statusEventEquals(tx, identity, row)))
          throw new Error(`hub_task_status_event ${input.id} differs from the pushed row`)
        return { id: input.id, status: 'duplicate' }
      }
      const adoption = await mirrorStatusEventRow(tx, identity, row)
      if (adoption) return { id: input.id, status: 'duplicate', adoptedId: adoption.id }
      return { id: input.id, status: 'applied' }
    },
  },
  [HOSTED_INTERVAL_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_INTERVAL_TABLE)
        throw new Error(`${input.table} was routed to the interval handler`)
      const outcome = await applyIntervalChangeInTransaction(tx, identity, input)
      return { id: input.id, ...outcome }
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
  [HOSTED_NOTE_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_NOTE_TABLE) throw new Error('wrong note handler')
      return applyHostedNotePush(tx, identity, input as NotePushChange)
    },
  },
  [HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE]: {
    async apply(tx, identity, input) {
      if (input.table !== HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE || input.op === 'delete')
        throw new Error('hub_note_acknowledgement accepts upsert only')
      const row: PushedNoteAcknowledgement = input.row
      const note = (await tx`SELECT id FROM hub_note WHERE id=${row.note_id}::uuid
        AND space_id=${identity.spaceId}::uuid AND deleted_at IS NULL`) as Array<{ id: string }>
      if (!note.length) throw new Error(DELETED_ON_HOSTED_RECORD_REASON)
      const projectId = await storedHubProjectId(tx, identity.spaceId, {
        projectId: row.projectId,
        projectName: row.project_name,
      })
      const existing = (await tx`SELECT * FROM hub_note_acknowledgement
        WHERE space_id=${identity.spaceId}::uuid AND note_id=${row.note_id}::uuid
        AND session_id=${row.session_id} FOR UPDATE`) as Array<
        PushedNoteAcknowledgement & { project_id: string | null }
      >
      const old = existing[0]
      const decision = decideNoteAcknowledgementUpsert(old ?? null, row)
      const storedProjectId = old?.project_id == null ? null : String(old.project_id)
      const sameProject = storedProjectId === projectId && old?.project_name === row.project_name
      if (decision.kind === 'duplicate' && sameProject)
        return {
          id: input.id,
          status: 'duplicate',
          ...(old!.id !== input.id ? { adoptedId: old!.id } : {}),
        }
      const adoptedId = old?.id ?? input.id
      const values = decision.kind === 'patch' ? decision.values : row
      await tx`INSERT INTO hub_note_acknowledgement
        (id,space_id,project_name,project_id,note_id,session_id,acknowledged_at,sightings,created_at,updated_at,deleted_at)
        VALUES (${adoptedId}::uuid,${identity.spaceId}::uuid,${row.project_name},${projectId}::uuid,
        ${row.note_id}::uuid,
        ${row.session_id},${values.acknowledged_at!}::timestamptz,${values.sightings!},
        ${row.created_at}::timestamptz,${values.updated_at ?? row.updated_at}::timestamptz,NULL)
        ON CONFLICT(space_id,note_id,session_id) DO UPDATE SET
        project_name=excluded.project_name,project_id=excluded.project_id,
        acknowledged_at=excluded.acknowledged_at,sightings=excluded.sightings,
        updated_at=excluded.updated_at,deleted_at=NULL`
      return { id: input.id, status: 'applied', ...(adoptedId !== input.id ? { adoptedId } : {}) }
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
  client: SQL,
  identity: TaskIdentity,
  inputs: HostedPushChange[],
) {
  return client.begin(async (tx) => {
    await bindTenant(tx, identity)
    return applyHostedPushChangesInTransaction(tx, identity, inputs)
  })
}
