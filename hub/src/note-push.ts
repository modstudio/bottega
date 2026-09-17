import { newRecordId } from '../../shared/record/schema.ts'
import { db } from './db.ts'
import { hostedMirrorNotes, hostedNoteCounts, type NoteClientOptions } from './note-client.ts'

export async function pushNotes(options: NoteClientOptions & { dryRun?: boolean } = {}) {
  const notes = db()
    .query<Record<string, unknown>, []>('SELECT * FROM note ORDER BY id')
    .all()
    .map((row) => ({
      id: (row.record_id as string) ?? newRecordId(),
      number: row.id as number,
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
      updated_at: row.last_seen_at as string,
      deleted_at: null,
    }))
  const byNumber = new Map(notes.map((row) => [row.number, row]))
  const acknowledgementRows = db()
    .query<Record<string, unknown>, []>(
      'SELECT * FROM note_acknowledgement ORDER BY note_id,session_id',
    )
    .all()
  const local = { note: notes.length, note_acknowledgement: acknowledgementRows.length }
  if (options.dryRun) return { local, hosted: null, match: null }
  const requestOptions = { baseUrl: options.baseUrl, token: options.token, fetch: options.fetch }
  for (let index = 0; index < notes.length; index += 500) {
    const mirrored = await hostedMirrorNotes(
      { notes: notes.slice(index, index + 500) },
      requestOptions,
    )
    for (const identity of mirrored.noteIds) byNumber.get(identity.number)!.id = identity.id
  }
  const acknowledgements = acknowledgementRows.map((row) => {
    const note = byNumber.get(row.note_id as number)!
    return {
      id: (row.record_id as string) ?? newRecordId(),
      note_id: note.id,
      project_name: note.project,
      session_id: row.session_id as string,
      acknowledged_at: row.acknowledged_at as string,
      sightings: row.sightings as number,
      created_at: row.acknowledged_at as string,
      updated_at: row.acknowledged_at as string,
      deleted_at: null,
    }
  })
  for (let index = 0; index < acknowledgements.length; index += 500)
    await hostedMirrorNotes(
      { notes: [], acknowledgements: acknowledgements.slice(index, index + 500) },
      requestOptions,
    )
  const projects = [...new Set(notes.map((row) => row.project))]
  await hostedMirrorNotes(
    {
      notes: [],
      raiseProjects: projects.map((project) => ({
        project,
        next: Math.max(1, ...notes.map((row) => row.number + 1)),
      })),
    },
    requestOptions,
  )
  const hosted = await hostedNoteCounts(requestOptions)
  return { local, hosted, match: JSON.stringify(local) === JSON.stringify(hosted) }
}
