// concern: note hosted record
/** Owns hosted note row adaptation and direct record sends. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { HostedChangeStageError, sendHostedChanges } from './hosted-change-sender.ts'
import type { HostedNote } from './hosted-notes.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import type { NoteClientOptions } from './note-client.ts'
import { noteDestinationOptions } from './note-project-space.ts'
import type { NoteRow } from './note-row.ts'
import {
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  type PushedNote,
  type PushedNoteAcknowledgement,
} from './push-contract.ts'

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

export async function noteChangeSendOptions(project: string, options?: NoteClientOptions) {
  return {
    ...(await noteDestinationOptions(project, options)),
    conflictRemedy: `${PLATFORM_SLUG} note list --project ${project}`,
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

function pushedAcknowledgement(input: {
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
    await noteChangeSendOptions(note.project, options),
  )
  return updated
}

export async function sendHostedNoteAcknowledgement(
  note: NoteRow,
  sessionId: string,
  at: string,
  options?: NoteClientOptions,
): Promise<PushedNoteAcknowledgement> {
  const acknowledgement = pushedAcknowledgement({ id: newRecordId(), note, sessionId, at })
  await sendHostedChanges(
    `note ${note.label}`,
    [
      [
        {
          table: HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
          id: acknowledgement.id,
          op: 'upsert',
          row: acknowledgement,
        },
      ],
    ],
    await noteChangeSendOptions(note.project, options),
  )
  return acknowledgement
}

export async function sendHostedNoteMerge(
  target: NoteRow,
  source: NoteRow,
  at: string,
  options?: NoteClientOptions,
): Promise<NoteRow> {
  const union = mergeNoteAnchors(
    target.anchors,
    source.anchors.map((anchor) => (anchor.id ? anchor : { ...anchor, id: newRecordId() })),
  )
  const merged: NoteRow = {
    ...target,
    anchors: union.anchors,
    sightings: union.sightings,
    last_seen_at:
      target.last_seen_at > source.last_seen_at ? target.last_seen_at : source.last_seen_at,
  }
  try {
    await sendHostedChanges(
      `note ${target.label}`,
      [
        [
          {
            table: HOSTED_NOTE_TABLE,
            id: target.record_id,
            op: 'upsert',
            row: pushedNote(merged, at),
            fields: ['anchors', 'last_seen_at'],
            expected_revision: target.revision,
          },
        ],
        [
          {
            table: HOSTED_NOTE_TABLE,
            id: source.record_id,
            op: 'delete',
            expected_revision: source.revision,
          },
        ],
      ],
      await noteChangeSendOptions(target.project, options),
    )
  } catch (cause) {
    if (cause instanceof HostedChangeStageError && cause.stageIndex === 1)
      throw new Error(
        `${cause.message}; the target holds the merged sightings but source ${source.label} still exists; rerun \`${PLATFORM_SLUG} note same ${target.label} ${source.label}\``,
      )
    throw cause
  }
  return merged
}

export async function sendHostedNoteDrop(
  current: NoteRow,
  reason: string,
  at: string,
  options?: NoteClientOptions,
): Promise<NoteRow> {
  const updated: NoteRow = {
    ...current,
    stale_at: at,
    stale_reason: `dropped: ${reason}`,
    last_seen_at: at,
  }
  await sendHostedChanges(
    `note ${current.label}`,
    [
      [
        {
          table: HOSTED_NOTE_TABLE,
          id: current.record_id,
          op: 'upsert',
          row: pushedNote(updated, at),
          fields: ['stale_at', 'stale_reason', 'last_seen_at'],
          expected_revision: current.revision,
        },
      ],
    ],
    await noteChangeSendOptions(current.project, options),
  )
  return updated
}
