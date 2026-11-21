import { db } from '../src/db.ts'
import { getNote, listNotes, resolveNoteReference } from '../src/note.ts'

type NoteRequestBody = {
  sameAs?: unknown
  anchor: string
  project: string
  text: string
  area?: string | null
  stale: Array<{ recordId: string }>
  annotated: Array<{ recordId: string }>
  restored: Array<{ recordId: string }>
  deleted: string[]
}

const identity = {
  userId: 'user-1',
  activeSpaceId: 'space-a',
  memberships: [
    { spaceId: 'space-a', slug: 'workshop', permission: 'write' },
    { spaceId: 'space-gamma', slug: 'declared-gamma-space', permission: 'write' },
  ],
  capabilities: {
    projectNoteCounters: true,
    noteTriageStaleness: true,
    spacePush: true,
    targetSpaceNotes: true,
    spacePushTables: ['hub_note', 'hub_note_acknowledgement'],
  },
}

const shape = (note: Awaited<ReturnType<typeof getNote>>, at: string) => ({
  id: note.record_id,
  number: note.number,
  project: note.project,
  project_name: note.project,
  text: note.text,
  area: note.area,
  anchors: JSON.stringify(note.anchors),
  sightings: note.sightings,
  created_at: note.created_at,
  last_seen_at: note.last_seen_at,
  stale_at: note.stale_at,
  stale_reason: note.stale_reason,
  promoted_task: note.promoted_task,
  updated_at: at,
  deleted_at: null,
})

async function getRoute(url: URL, at: string) {
  const noteMatch = /^\/v1\/notes\/([0-9a-f-]{36})$/i.exec(url.pathname)
  if (noteMatch) {
    try {
      return Response.json(shape(await getNote(noteMatch[1]!, { baseUrl: '' }), at))
    } catch {
      return Response.json({ error: 'note not found' }, { status: 404 })
    }
  }
  const notes = await listNotes(
    {
      project: url.searchParams.get('project') ?? undefined,
      stale: url.searchParams.has('stale') ? url.searchParams.get('stale') === 'true' : undefined,
      actionable: url.searchParams.get('actionable') === 'true',
    },
    { baseUrl: '' },
  )
  const acknowledgements = db()
    .query<
      {
        id: string
        note_id: string
        project_name: string
        session_id: string
        acknowledged_at: string
        sightings: number
      },
      []
    >(
      `SELECT a.record_id id,a.note_record_id note_id,n.project project_name,a.session_id,
       a.acknowledged_at,a.sightings FROM note_acknowledgement a
       JOIN note n ON n.record_id=a.note_record_id`,
    )
    .all()
    .map((row) => ({
      ...row,
      created_at: row.acknowledged_at,
      updated_at: row.acknowledged_at,
      deleted_at: null,
    }))
  return Response.json({
    notes: notes.map((note) => shape(note, at)),
    acknowledgements,
    cursor: 'done',
    more: false,
  })
}

async function postNote(body: NoteRequestBody, at: string) {
  if (body.sameAs) {
    const old = await getNote(resolveNoteReference(String(body.sameAs), 'workshop'))
    return Response.json({
      ...shape(old, at),
      anchors: JSON.stringify([...old.anchors, JSON.parse(body.anchor)]),
      sightings: old.sightings + 1,
      last_seen_at: at,
      stale_at: null,
      stale_reason: null,
    })
  }
  const next =
    (db().query<{ max: number | null }, []>('SELECT max(number) max FROM note').get()?.max ?? 0) + 1
  return Response.json({
    id: crypto.randomUUID(),
    number: next,
    project: body.project,
    project_name: body.project,
    text: body.text,
    area: body.area ?? null,
    anchors: `[${body.anchor}]`,
    sightings: 1,
    created_at: at,
    last_seen_at: at,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    updated_at: at,
    deleted_at: null,
  })
}

export const noteHostedFetch = async (input: string, init?: RequestInit) => {
  const url = new URL(input)
  const rawBody: unknown = init?.body ? JSON.parse(String(init.body)) : {}
  const body = rawBody as NoteRequestBody
  const at = new Date().toISOString()
  if (url.pathname === '/v1/tasks/identity') return Response.json(identity)
  if (url.pathname === '/v1/changes') {
    const changes = rawBody as Array<{ id: string }>
    return Response.json(changes.map((change) => ({ id: change.id, status: 'applied' })))
  }
  if (url.pathname.startsWith('/v1/notes') && init?.method === 'GET') return getRoute(url, at)
  if (url.pathname === '/v1/notes' && init?.method === 'POST') return postNote(body, at)
  if (url.pathname === '/v1/notes/reap')
    return Response.json({
      marked: body.stale.length,
      annotated: body.annotated.length,
      restored: body.restored.length,
      deleted: body.deleted.length,
      staleIds: body.stale.map((row: { recordId: string }) => row.recordId),
      annotatedIds: body.annotated.map((row: { recordId: string }) => row.recordId),
      restoredIds: body.restored.map((row: { recordId: string }) => row.recordId),
      deletedIds: body.deleted,
    })
  return Response.json({ error: 'unexpected route' }, { status: 500 })
}
