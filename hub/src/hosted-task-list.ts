import type { SQL } from 'bun'
import {
  decodeHostedPullCursor,
  encodeHostedPullCursor,
  type HostedPullCursor,
  hostedPullCursorAt,
  hostedPullLimit,
} from './hosted-pull-page.ts'
import { taskIdFor } from './hosted-task-reference.ts'
import {
  type HostedComment,
  type HostedDocument,
  type HostedStatusEvent,
  type HostedTask,
  hostedTaskPullSerializers,
} from './hosted-tasks.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tenant.ts'

const streams = ['tasks', 'comments', 'documents', 'statusEvents'] as const
type TaskStream = (typeof streams)[number]
type CursorRow<T> = T & { cursor_at: string }
type TaskCursorRow = CursorRow<HostedTask | HostedComment | HostedDocument | HostedStatusEvent>

export type HostedTaskListFilters = {
  project?: string
  status?: string
  parent?: string
  updatedSince?: string
  includeDeleted?: boolean
  cursor?: string
  limit?: number
}

const emptyPage = () => ({
  tasks: [] as HostedTask[],
  comments: [] as HostedComment[],
  documents: [] as HostedDocument[],
  statusEvents: [] as HostedStatusEvent[],
})

function serializeRow<T extends { id: string }>(row: CursorRow<T>, serialize: (value: T) => T) {
  const { cursor_at: cursorAt, ...value } = row
  return { value: serialize(value as unknown as T), cursorAt: hostedPullCursorAt(cursorAt) }
}

async function taskCandidates(
  tx: SQL,
  identity: TaskIdentity,
  filters: HostedTaskListFilters,
  cursor: HostedPullCursor<TaskStream>,
  parentId: string | null,
  limit: number,
): Promise<TaskCursorRow[]> {
  if (cursor.stream === 'tasks')
    return (await tx`
      SELECT *,to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
      FROM hub_task WHERE space_id=${identity.spaceId}::uuid
        AND (${filters.project ?? null}::text IS NULL OR project_name=${filters.project ?? null})
        AND (${filters.status ?? null}::text IS NULL OR status_category=${filters.status ?? null})
        AND (${filters.parent ?? null}::text IS NULL OR parent_id=${parentId}::uuid
          OR (parent_id IS NULL AND parent_key=${filters.parent ?? null}))
        AND updated_at > ${cursor.since}::timestamptz
        AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at,id LIMIT ${limit + 1}`) as TaskCursorRow[]
  if (cursor.stream === 'comments')
    return (await tx`
      SELECT *,to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
      FROM hub_task_comment WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${cursor.since}::timestamptz
        AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at,id LIMIT ${limit + 1}`) as TaskCursorRow[]
  if (cursor.stream === 'documents')
    return (await tx`
      SELECT *,to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
      FROM hub_task_document WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${cursor.since}::timestamptz
        AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at,id LIMIT ${limit + 1}`) as TaskCursorRow[]
  return (await tx`
    SELECT *,to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
    FROM hub_task_status_event WHERE space_id=${identity.spaceId}::uuid
      AND updated_at > ${cursor.since}::timestamptz
      AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
      AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
    ORDER BY updated_at,id LIMIT ${limit + 1}`) as TaskCursorRow[]
}

function taskPage(stream: TaskStream, selected: TaskCursorRow[]) {
  const page = emptyPage()
  if (stream === 'tasks')
    page.tasks = selected.map(
      (row) => serializeRow(row as CursorRow<HostedTask>, hostedTaskPullSerializers.hub_task).value,
    )
  if (stream === 'comments')
    page.comments = selected.map(
      (row) =>
        serializeRow(row as CursorRow<HostedComment>, hostedTaskPullSerializers.hub_task_comment)
          .value,
    )
  if (stream === 'documents')
    page.documents = selected.map(
      (row) =>
        serializeRow(row as CursorRow<HostedDocument>, hostedTaskPullSerializers.hub_task_document)
          .value,
    )
  if (stream === 'statusEvents')
    page.statusEvents = selected.map(
      (row) =>
        serializeRow(
          row as CursorRow<HostedStatusEvent>,
          hostedTaskPullSerializers.hub_task_status_event,
        ).value,
    )
  return page
}

export async function listHostedTasks(
  client: SQL,
  identity: TaskIdentity,
  filters: HostedTaskListFilters,
) {
  return withHostedTenant(client, identity, async (tx) => {
    const limit = hostedPullLimit(filters.limit)
    let cursor = decodeHostedPullCursor(filters.cursor, streams, filters.updatedSince)
    const parentId = filters.parent ? await taskIdFor(tx, identity.spaceId, filters.parent) : null

    for (;;) {
      const position = streams.indexOf(cursor.stream)
      const candidates = await taskCandidates(tx, identity, filters, cursor, parentId, limit)
      if (!candidates.length && position < streams.length - 1) {
        cursor = {
          ...cursor,
          stream: streams[position + 1]!,
          at: cursor.since,
          id: '00000000-0000-0000-0000-000000000000',
        }
        continue
      }

      const selected = candidates.slice(0, limit)
      const last = selected.at(-1)
      const next = last
        ? { ...cursor, at: hostedPullCursorAt(last.cursor_at), id: last.id }
        : cursor
      return {
        ...taskPage(cursor.stream, selected),
        cursor: encodeHostedPullCursor(next),
        more: candidates.length > limit || position < streams.length - 1,
      }
    }
  })
}
