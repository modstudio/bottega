// concern: note-outside
/** Adapts hosted outside notes to the CLI's note row shape without caching them. */

import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import {
  hostedCreateOutsideNote,
  hostedListOutsideNotes,
  type NoteClientOptions,
} from './note-client.ts'
import { formatNoteLabel } from './note-label.ts'
import type { NoteRow } from './note-row.ts'

export type OutsideNoteRow = NoteRow<NoteAnchorWire>

export async function listOutsideProjectNotes(
  project: string,
  hosted?: NoteClientOptions,
): Promise<OutsideNoteRow[]> {
  const remote = await hostedListOutsideNotes(project, hosted)
  return remote.map((row) => ({
    record_id: row.id,
    number: row.number,
    label: formatNoteLabel(row.project, row.number),
    project: row.project,
    text: row.text,
    area: row.area,
    anchors: row.anchors,
    sightings: row.sightings,
    created_at: row.created_at,
    last_seen_at: row.created_at,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
  }))
}

export async function createOutsideProjectNote(
  input: { project: string; text: string; area: string | null; anchor: NoteAnchorWire },
  hosted?: NoteClientOptions,
): Promise<OutsideNoteRow> {
  const created = await hostedCreateOutsideNote(
    { ...input, anchor: JSON.stringify(input.anchor) },
    hosted,
  )
  const at = new Date().toISOString()
  return {
    record_id: created.id,
    number: created.number,
    label: formatNoteLabel(created.project, created.number),
    project: created.project,
    text: input.text,
    area: input.area,
    anchors: [input.anchor],
    sightings: 1,
    created_at: at,
    last_seen_at: at,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
  }
}
