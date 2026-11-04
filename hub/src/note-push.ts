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

function acknowledgementsFor(
  rows: Record<string, unknown>[],
  selectedIds: Set<string>,
  noteById: Map<string, { project: string; projectId: string }>,
) {
  return rows
    .filter((row) => selectedIds.has(row.note_record_id as string))
    .map((row) => ({
      id: row.record_id as string,
      note_id: row.note_record_id as string,
      project_name: noteById.get(row.note_record_id as string)!.project,
      projectId: noteById.get(row.note_record_id as string)!.projectId,
      session_id: row.session_id as string,
      acknowledged_at: row.acknowledged_at as string,
      sightings: row.sightings as number,
      created_at: row.acknowledged_at as string,
      updated_at: row.acknowledged_at as string,
      deleted_at: null,
    }))
}

async function pushDestination(input: {
  notes: Record<string, unknown>[]
  acknowledgements: Record<string, unknown>[]
  counters: Array<{ project: string; projectId: string; next: number }>
  options: NoteClientOptions
}) {
  let skippedNotes = 0
  let skippedAcknowledgements = 0
  for (const batch of chunks(input.notes))
    skippedNotes += (await hostedMirrorNotes({ notes: batch }, input.options)).skippedHidden.length
  for (const batch of chunks(input.acknowledgements))
    skippedAcknowledgements += (
      await hostedMirrorNotes({ notes: [], acknowledgements: batch }, input.options)
    ).skippedHidden.length
  await hostedMirrorNotes({ notes: [], raiseProjects: input.counters }, input.options)
  const counts = await hostedNoteCounts(input.options)
  return {
    counts,
    skippedNotes,
    skippedAcknowledgements,
    match:
      counts.note === input.notes.length - skippedNotes &&
      counts.note_acknowledgement === input.acknowledgements.length - skippedAcknowledgements,
  }
}

function localNotes() {
  return db()
    .query<Record<string, unknown>, []>('SELECT * FROM note ORDER BY record_id')
    .all()
    .map((row) => ({
      id: row.record_id as string,
      number: row.number as number,
      project: row.project as string,
      project_name: row.project as string,
      projectId: row.project_record_id as string,
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
}

export async function pushNotes(options: NoteClientOptions & { dryRun?: boolean } = {}) {
  const notes = localNotes()
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
  const counters = db()
    .query<{ project: string; projectId: string; next: number }, []>(
      'SELECT project,project_record_id AS projectId,next FROM note_counter ORDER BY project',
    )
    .all()
  const partitionedCounters = partitionProjectRows(
    counters.map((counter) => ({ ...counter, project_name: counter.project })),
    projects(),
    identity,
  )
  const refusals = new Map<string, string>()
  for (const [project, refusal] of partitioned.refusals)
    refusals.set(project, `${project}: ${refusal.reason}`)
  for (const [project, refusal] of partitionedCounters.refusals)
    refusals.set(project, `${project}: ${refusal.reason}`)
  const failures = [...refusals.values()]
  const hosted = { note: 0, note_acknowledgement: 0 }
  const skippedHidden = { note: 0, note_acknowledgement: 0 }
  let match = true
  const noteById = new Map(notes.map((note) => [note.id, note]))

  const destinationSpaceIds = new Set([
    ...partitioned.destinations.keys(),
    ...partitionedCounters.destinations.keys(),
  ])
  for (const spaceId of destinationSpaceIds) {
    const selectedNotes = partitioned.destinations.get(spaceId) ?? []
    const selectedIds = new Set(selectedNotes.map((note) => note.id))
    const acknowledgements = acknowledgementsFor(acknowledgementRows, selectedIds, noteById)
    const selectedCounters = (partitionedCounters.destinations.get(spaceId) ?? []).map(
      ({ project, projectId, next }) => ({ project, projectId, next }),
    )
    const targeted = { ...requestOptions, recordSpace: spaceId }
    try {
      const result = await pushDestination({
        notes: selectedNotes,
        acknowledgements,
        counters: selectedCounters,
        options: targeted,
      })
      skippedHidden.note += result.skippedNotes
      skippedHidden.note_acknowledgement += result.skippedAcknowledgements
      hosted.note += result.counts.note
      hosted.note_acknowledgement += result.counts.note_acknowledgement
      match &&= result.match
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length) throw new Error(`hosted note pushes failed: ${failures.join('; ')}`)
  const skipped = skippedHidden.note + skippedHidden.note_acknowledgement
  return {
    local,
    hosted,
    match,
    skippedHidden,
    ...(skipped
      ? {
          notice: `${skipped} note push rows were skipped because they are hidden by a space owner`,
        }
      : {}),
  }
}
