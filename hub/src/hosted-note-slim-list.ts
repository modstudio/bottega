// concern: hosted note slim list
/** Owns the bounded, filtered hosted note-list projection. */

import type { SQL } from 'bun'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tenant.ts'
import { noteListLimit, type SlimNote } from './note-slim-list-shape.ts'

export type HostedSlimNoteListFilters = {
  project?: string
  stale?: boolean
  actionable?: boolean
  sessions?: string[]
  kept?: boolean
  text?: string
  limit?: number
}

type SlimNoteRow = Omit<SlimNote, 'record_id' | 'label'> & {
  id: string
  total: number | string
}

export async function listHostedSlimNotes(
  url: SQL,
  identity: TaskIdentity,
  filters: HostedSlimNoteListFilters,
): Promise<{ notes: SlimNote[]; total: number }> {
  return withHostedTenant(url, identity, async (tx) => {
    const sessions = [
      ...new Set((filters.sessions ?? []).map((value) => value.trim()).filter(Boolean)),
    ]
    const limit = noteListLimit(filters.limit)
    const selected = (await tx`
      SELECT id,number::int number,project,text,sightings::int sightings,created_at,last_seen_at,
        stale_at,stale_reason,promoted_task,count(*) OVER ()::int total
      FROM hub_note note
      WHERE space_id=${identity.spaceId}::uuid
        AND deleted_at IS NULL
        AND (${filters.project ?? null}::text IS NULL OR project=${filters.project ?? null})
        AND (${filters.stale === undefined ? null : filters.stale}::boolean IS NULL
          OR (${filters.stale ?? false} AND stale_at IS NOT NULL)
          OR (NOT ${filters.stale ?? false} AND stale_at IS NULL))
        AND (NOT ${filters.actionable ?? false} OR (stale_at IS NULL AND promoted_task IS NULL))
        AND (${filters.text ?? null}::text IS NULL
          OR position(lower(${filters.text ?? ''}) in lower(text)) > 0)
        AND (${sessions.length === 0} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(note.anchors::jsonb) anchor
          WHERE anchor->>'session_id'=ANY(${tx.array(sessions, 'text')})
        ))
        AND (${sessions.length === 0} OR ${filters.kept ?? false} = EXISTS (
          SELECT 1 FROM hub_note_acknowledgement acknowledgement
          WHERE acknowledgement.space_id=note.space_id
            AND acknowledgement.deleted_at IS NULL
            AND acknowledgement.note_id=note.id
            AND acknowledgement.session_id=ANY(${tx.array(sessions, 'text')})
            AND acknowledgement.sightings=note.sightings
        ))
      ORDER BY last_seen_at DESC,id DESC
      LIMIT ${limit ?? null}
    `) as SlimNoteRow[]
    return {
      notes: selected.map(({ id, total: _total, ...row }) => ({
        ...row,
        record_id: id,
        label: formatNoteLabel(row.project, row.number),
      })),
      total: Number(selected[0]?.total ?? 0),
    }
  })
}
