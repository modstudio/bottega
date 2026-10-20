import type { SQL } from 'bun'
import {
  decodeHostedPullCursor,
  encodeHostedPullCursor,
  type HostedPullCursor,
  type HostedPullMeasuredRow,
  hostedPullBodyCandidates,
  hostedPullLimit,
  hostedPullPage,
  hostedPullRowValue,
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
type TaskCursorRow = HostedPullMeasuredRow<
  HostedTask | HostedComment | HostedDocument | HostedStatusEvent
>

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

function serializeRow<T extends { id: string }>(
  row: HostedPullMeasuredRow<T>,
  serialize: (value: T) => T,
) {
  return serialize(hostedPullRowValue(row))
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
    return hostedPullBodyCandidates<TaskCursorRow>(tx, tx.unsafe("COALESCE(body,'')"), limit)`
        SELECT * FROM hub_task WHERE space_id=${identity.spaceId}::uuid
        AND (${filters.project ?? null}::text IS NULL OR project_name=${filters.project ?? null})
        AND (${filters.status ?? null}::text IS NULL OR status_category=${filters.status ?? null})
        AND (${filters.parent ?? null}::text IS NULL OR parent_id=${parentId}::uuid
          OR (parent_id IS NULL AND parent_key=${filters.parent ?? null}))
        AND updated_at > ${cursor.since}::timestamptz
        AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
    `
  if (cursor.stream === 'comments')
    return hostedPullBodyCandidates<TaskCursorRow>(tx, tx.unsafe('body'), limit)`
        SELECT * FROM hub_task_comment WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${cursor.since}::timestamptz
        AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
    `
  if (cursor.stream === 'documents')
    return hostedPullBodyCandidates<TaskCursorRow>(tx, tx.unsafe('body'), limit)`
        SELECT * FROM hub_task_document WHERE space_id=${identity.spaceId}::uuid
        AND updated_at > ${cursor.since}::timestamptz
        AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
        AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
    `
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
    page.tasks = selected.map((row) =>
      serializeRow(row as HostedPullMeasuredRow<HostedTask>, hostedTaskPullSerializers.hub_task),
    )
  if (stream === 'comments')
    page.comments = selected.map((row) =>
      serializeRow(
        row as HostedPullMeasuredRow<HostedComment>,
        hostedTaskPullSerializers.hub_task_comment,
      ),
    )
  if (stream === 'documents')
    page.documents = selected.map((row) =>
      serializeRow(
        row as HostedPullMeasuredRow<HostedDocument>,
        hostedTaskPullSerializers.hub_task_document,
      ),
    )
  if (stream === 'statusEvents')
    page.statusEvents = selected.map((row) =>
      serializeRow(
        row as HostedPullMeasuredRow<HostedStatusEvent>,
        hostedTaskPullSerializers.hub_task_status_event,
      ),
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
      const candidates = await taskCandidates(tx, identity, filters, cursor, parentId, limit)
      const result = hostedPullPage(streams, cursor, candidates, limit)
      if (result.kind === 'advance') {
        cursor = result.cursor
        continue
      }
      return {
        ...taskPage(cursor.stream, result.rows),
        cursor: encodeHostedPullCursor(result.cursor),
        more: result.more,
      }
    }
  })
}
