import { db } from './db.ts'
import { hostedMirrorNotes, hostedNoteCounts, type NoteClientOptions } from './note-client.ts'
import { projects } from './projects.ts'
import { hostedTaskIdentity } from './task-client.ts'
import { partitionProjectRows } from './task-project-space.ts'

const chunks = <T>(rows: T[]): T[][] => {
  const result: T[][] = []
  for (let index = 0; index < rows.length; index += 500) result.push(rows.slice(index, index + 500))
  return result
}

export async function pushNotes(options: NoteClientOptions & { dryRun?: boolean } = {}) {
  const notes = db()
    .query<Record<string, unknown>, []>('SELECT * FROM note ORDER BY record_id')
    .all()
    .map((row) => ({
      id: row.record_id as string,
      number: row.number as number,
      project: row.project as string,
      project_name: row.project as string,
      text: row.text as string,
      area: row.area as string | null,
      anchors: row.anchors as string,
      sightings: row.sightings as number,
      created_at: row.created_at as string,
      last_seen_at: row.last_seen_at as string,
      stale_at: row.stale_at as string | null,
      stale_reason: row.stale_reason as string | null,
      promoted_task: row.promoted_task as string | null,
      promoted_task_id: row.promoted_task_record_id as string | null,
      updated_at: row.last_seen_at as string,
      deleted_at: null,
    }))
  const acknowledgementRows = db()
    .query<Record<string, unknown>, []>(
      'SELECT * FROM note_acknowledgement ORDER BY note_record_id,session_id',
    )
    .all()
  const local = { note: notes.length, note_acknowledgement: acknowledgementRows.length }
  if (options.dryRun) return { local, hosted: null, match: null }

  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  const identity = await hostedTaskIdentity(requestOptions)
  const partitioned = partitionProjectRows(notes, projects(), identity)
  const failures = [...partitioned.refusals].map(
    ([project, refusal]) => `${project}: ${refusal.reason}`,
  )
  const hosted = { note: 0, note_acknowledgement: 0 }
  let match = true
  const noteById = new Map(notes.map((note) => [note.id, note]))
  const counters = db()
    .query<{ project: string; next: number }, []>(
      'SELECT project,next FROM note_counter ORDER BY project',
    )
    .all()

  for (const [spaceId, selectedNotes] of partitioned.destinations) {
    const selectedIds = new Set(selectedNotes.map((note) => note.id))
    const acknowledgements = acknowledgementRows
      .filter((row) => selectedIds.has(row.note_record_id as string))
      .map((row) => ({
        id: row.record_id as string,
        note_id: row.note_record_id as string,
        project_name: noteById.get(row.note_record_id as string)!.project,
        session_id: row.session_id as string,
        acknowledged_at: row.acknowledged_at as string,
        sightings: row.sightings as number,
        created_at: row.acknowledged_at as string,
        updated_at: row.acknowledged_at as string,
        deleted_at: null,
      }))
    const selectedProjects = new Set(selectedNotes.map((note) => note.project))
    const selectedCounters = counters.filter((counter) => selectedProjects.has(counter.project))
    const targeted = { ...requestOptions, recordSpace: spaceId }
    try {
      for (const batch of chunks(selectedNotes)) await hostedMirrorNotes({ notes: batch }, targeted)
      for (const batch of chunks(acknowledgements))
        await hostedMirrorNotes({ notes: [], acknowledgements: batch }, targeted)
      await hostedMirrorNotes({ notes: [], raiseProjects: selectedCounters }, targeted)
      const counts = await hostedNoteCounts(targeted)
      hosted.note += counts.note
      hosted.note_acknowledgement += counts.note_acknowledgement
      match &&=
        counts.note === selectedNotes.length &&
        counts.note_acknowledgement === acknowledgements.length
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length) throw new Error(`hosted note pushes failed: ${failures.join('; ')}`)
  return { local, hosted, match }
}
