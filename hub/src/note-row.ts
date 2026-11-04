// concern: note-row
/** Shared note display shape for local and outside note services. */

import type { NoteAnchorWire } from '../../shared/note-anchor.ts'

export type NoteRow<Anchor = NoteAnchorWire> = {
  record_id: string
  number: number
  label: string
  project: string
  text: string
  area: string | null
  anchors: Anchor[]
  sightings: number
  created_at: string
  last_seen_at: string
  stale_at: string | null
  stale_reason: string | null
  promoted_task: string | null
}
