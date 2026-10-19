import type { SQL } from 'bun'
import {
  type HostedAcknowledgement,
  type HostedNote,
  hostedNotePullSerializers,
} from './hosted-notes.ts'
import {
  decodeHostedPullCursor,
  encodeHostedPullCursor,
  type HostedPullCursor,
  hostedPullLimit,
  hostedPullPage,
} from './hosted-pull-page.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tenant.ts'

const streams = ['notes', 'acknowledgements', 'projectCounters'] as const
type NoteStream = (typeof streams)[number]
type CursorRow<T> = T & { cursor_at: string }
type CounterRow = { id: string; project: string; next: string; cursor_at: string }
type NoteCursorRow = CursorRow<HostedNote | HostedAcknowledgement> | CounterRow

export type HostedNoteListFilters = {
  project?: string
  stale?: boolean
  actionable?: boolean
  updatedSince?: string
  includeDeleted?: boolean
  cursor?: string
  limit?: number
}

async function noteCandidates(
  tx: SQL,
  identity: TaskIdentity,
  filters: HostedNoteListFilters,
  cursor: HostedPullCursor<NoteStream>,
  limit: number,
): Promise<NoteCursorRow[]> {
  if (cursor.stream === 'notes')
    return (await tx`SELECT hub_note.*,number::int number,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
      FROM hub_note WHERE space_id=${identity.spaceId}::uuid
      AND (${filters.project ?? null}::text IS NULL OR project=${filters.project ?? null})
      AND (${filters.stale === undefined ? null : filters.stale}::boolean IS NULL
        OR (${filters.stale ?? false} AND stale_at IS NOT NULL)
        OR (NOT ${filters.stale ?? false} AND stale_at IS NULL))
      AND (NOT ${filters.actionable ?? false} OR (stale_at IS NULL AND promoted_task IS NULL))
      AND updated_at > ${cursor.since}::timestamptz
      AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
      AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at,id LIMIT ${limit + 1}`) as NoteCursorRow[]
  if (cursor.stream === 'acknowledgements')
    return (await tx`SELECT *,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
      FROM hub_note_acknowledgement WHERE space_id=${identity.spaceId}::uuid
      AND updated_at > ${cursor.since}::timestamptz
      AND (updated_at,id) > (${cursor.at}::timestamptz,${cursor.id}::uuid)
      AND (${filters.includeDeleted ?? false} OR deleted_at IS NULL)
      ORDER BY updated_at,id LIMIT ${limit + 1}`) as NoteCursorRow[]
  return (await tx`SELECT p.id,p.name project,s.next::text next,
      '1970-01-01T00:00:00.000000Z' cursor_at FROM seq s JOIN project p
      ON p.space_id=s.space_id AND p.id=s.project_id
      WHERE s.space_id=${identity.spaceId}::uuid AND s.name='note'
      AND p.id > ${cursor.id}::uuid ORDER BY p.id LIMIT ${limit + 1}`) as NoteCursorRow[]
}

function notePage(stream: NoteStream, selected: NoteCursorRow[]) {
  const page = {
    notes: [] as HostedNote[],
    acknowledgements: [] as HostedAcknowledgement[],
    projectCounters: [] as Array<{ project: string; next: number }>,
  }
  if (stream === 'notes')
    page.notes = selected.map((row) => {
      const { cursor_at: _, ...value } = row as CursorRow<HostedNote>
      return hostedNotePullSerializers.hub_note(value as HostedNote)
    })
  if (stream === 'acknowledgements')
    page.acknowledgements = selected.map((row) => {
      const { cursor_at: _, ...value } = row as CursorRow<HostedAcknowledgement>
      return hostedNotePullSerializers.hub_note_acknowledgement(value as HostedAcknowledgement)
    })
  if (stream === 'projectCounters')
    page.projectCounters = selected.map((row) => ({
      project: String((row as CounterRow).project),
      next: Number((row as CounterRow).next),
    }))
  return page
}

export async function listHostedNotes(
  url: SQL,
  identity: TaskIdentity,
  filters: HostedNoteListFilters,
) {
  return withHostedTenant(url, identity, async (tx) => {
    const limit = hostedPullLimit(filters.limit)
    let cursor = decodeHostedPullCursor(filters.cursor, streams, filters.updatedSince)
    for (;;) {
      const candidates = await noteCandidates(tx, identity, filters, cursor, limit)
      const result = hostedPullPage(streams, cursor, candidates, limit)
      if (result.kind === 'advance') {
        cursor = result.cursor
        continue
      }
      return {
        ...notePage(cursor.stream, result.rows),
        cursor: encodeHostedPullCursor(result.cursor),
        more: result.more,
      }
    }
  })
}
