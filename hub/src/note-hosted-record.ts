// concern: note hosted record
/** Adapts canonical hosted note rows to the note service and direct change contract. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { sendHostedChanges } from './hosted-change-sender.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import {
  hostedGetNote,
  hostedListNotes,
  isMissingHostedNote,
  type NoteClientOptions,
} from './note-client.ts'
import { noteDestinationOptions } from './note-project-space.ts'
import type { NoteRow } from './note-row.ts'
import {
  HOSTED_NOTE_TABLE,
  type PushedNote,
  type PushedNoteAcknowledgement,
} from './push-contract.ts'

export type NoteFilters = {
  project?: string
  stale?: boolean
  session?: string | string[]
  actionable?: boolean
  kept?: boolean
  text?: string
}

const readRemedy = `run \`${PLATFORM_SLUG} record doctor\`, then retry`

function hostedReadFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${message}. ${readRemedy}`)
}

export function noteRowFromHosted(row: HostedNote): NoteRow {
  return {
    record_id: row.id,
    number: row.number,
    label: formatNoteLabel(row.project, row.number),
    project: row.project,
    project_record_id: row.projectId ?? null,
    text: row.text,
    area: row.area,
    anchors: JSON.parse(row.anchors),
    sightings: row.sightings,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    stale_at: row.stale_at,
    stale_reason: row.stale_reason,
    promoted_task: row.promoted_task,
    promoted_task_record_id: row.promoted_task_id ?? null,
    revision: row.revision,
  }
}

export async function readHostedNote(
  recordId: string,
  options?: NoteClientOptions,
): Promise<NoteRow> {
  try {
    return noteRowFromHosted(await hostedGetNote(recordId, options))
  } catch (cause) {
    if (isMissingHostedNote(cause)) throw new Error(`no note ${recordId}`)
    throw hostedReadFailure(cause)
  }
}

const sessionsFrom = (session: NoteFilters['session']) => [
  ...new Set(
    (Array.isArray(session) ? session : session ? [session] : [])
      .map((value) => value.trim())
      .filter(Boolean),
  ),
]

function acknowledgementMatches(
  acknowledgement: HostedAcknowledgement,
  note: NoteRow,
  sessions: string[],
) {
  return (
    !acknowledgement.deleted_at &&
    acknowledgement.note_id === note.record_id &&
    sessions.includes(acknowledgement.session_id) &&
    acknowledgement.sightings === note.sightings
  )
}

export async function listHostedNoteRows(
  filters: NoteFilters,
  options?: NoteClientOptions,
): Promise<NoteRow[]> {
  const sessions = sessionsFrom(filters.session)
  if (filters.kept && !sessions.length) throw new Error('listing kept notes requires a session')
  try {
    const result = await hostedListNotes(
      {
        project: filters.project,
        stale: filters.stale,
        actionable: filters.actionable,
      },
      options,
    )
    const search = filters.text?.toLowerCase()
    return result.notes
      .map(noteRowFromHosted)
      .filter((note) =>
        sessions.length
          ? note.anchors.some((anchor) =>
              sessions.includes(typeof anchor.session_id === 'string' ? anchor.session_id : ''),
            ) &&
            filters.kept ===
              result.acknowledgements.some((acknowledgement) =>
                acknowledgementMatches(acknowledgement, note, sessions),
              )
          : true,
      )
      .filter((note) => !search || note.text.toLowerCase().includes(search))
      .sort(
        (left, right) =>
          right.last_seen_at.localeCompare(left.last_seen_at) ||
          right.record_id.localeCompare(left.record_id),
      )
  } catch (cause) {
    throw hostedReadFailure(cause)
  }
}

export function pushedNote(note: NoteRow, at: string): PushedNote {
  return {
    id: note.record_id,
    number: note.number,
    project: note.project,
    project_name: note.project,
    projectId: note.project_record_id,
    text: note.text,
    area: note.area,
    anchors: JSON.stringify(note.anchors),
    sightings: note.sightings,
    created_at: note.created_at,
    last_seen_at: note.last_seen_at,
    stale_at: note.stale_at,
    stale_reason: note.stale_reason,
    promoted_task: note.promoted_task,
    promoted_task_id: note.promoted_task_record_id ?? null,
    updated_at: at,
    deleted_at: null,
    revision: note.revision,
  }
}

export function pushedAcknowledgement(input: {
  id: string
  note: NoteRow
  sessionId: string
  at: string
}): PushedNoteAcknowledgement {
  return {
    id: input.id,
    project_name: input.note.project,
    projectId: input.note.project_record_id,
    note_id: input.note.record_id,
    session_id: input.sessionId,
    acknowledged_at: input.at,
    sightings: input.note.sightings,
    created_at: input.at,
    updated_at: input.at,
    deleted_at: null,
  }
}

export async function sendHostedRepeatSighting(
  note: NoteRow,
  anchor: NoteAnchorWire,
  at: string,
  options?: NoteClientOptions,
): Promise<NoteRow> {
  const union = mergeNoteAnchors(note.anchors, [anchor])
  const updated: NoteRow = {
    ...note,
    anchors: union.anchors,
    sightings: union.sightings,
    last_seen_at: at,
    stale_at: null,
    stale_reason: null,
  }
  const destination = await noteDestinationOptions(note.project, options)
  await sendHostedChanges(
    `note ${note.label}`,
    [
      [
        {
          table: HOSTED_NOTE_TABLE,
          id: note.record_id,
          op: 'upsert',
          row: pushedNote(updated, at),
          fields: ['anchors', 'last_seen_at'],
          expected_revision: note.revision,
        },
      ],
    ],
    {
      ...destination,
      conflictRemedy: `${PLATFORM_SLUG} note list --project ${note.project}`,
    },
  )
  return updated
}
