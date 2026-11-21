// concern: note-row
/** Owns the shared note row shape and local-row/project adaptations. */

import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { projects } from './projects.ts'

export type NoteRow<Anchor = NoteAnchorWire> = {
  record_id: string
  number: number
  label: string
  project: string
  project_record_id?: string | null
  text: string
  area: string | null
  anchors: Anchor[]
  sightings: number
  created_at: string
  last_seen_at: string
  stale_at: string | null
  stale_reason: string | null
  promoted_task: string | null
  promoted_task_record_id?: string | null
  revision?: number
}

export function decodeNoteRow(
  row: Omit<NoteRow, 'anchors' | 'label'> & { anchors: string },
): NoteRow {
  return {
    ...row,
    label: formatNoteLabel(row.project, row.number),
    anchors: JSON.parse(row.anchors),
  }
}

export const isRegisteredNoteProject = (name: string) =>
  projects().some((project) => project.name === name)
