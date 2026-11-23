// concern: note slim list shape
/** Owns the shared slim note-list response shape and limit validation. */

export type SlimNote = {
  record_id: string
  label: string
  number: number
  project: string
  text: string
  sightings: number
  created_at: string
  last_seen_at: string
  stale_at: string | null
  stale_reason: string | null
  promoted_task: string | null
}

export function noteListLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('limit must be a positive integer; omit it to list every matching note')
  return value
}
