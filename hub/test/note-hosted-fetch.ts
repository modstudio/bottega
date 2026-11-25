import { RECORD_SPACE_HEADER_NAME } from '../../shared/record-request-headers.ts'
import { db } from '../src/db.ts'
import { resolveNoteReference } from '../src/note.ts'
import { noteDuplicateQuestionCandidates } from '../src/note-duplicate-candidates.ts'
import { getNote, listNotes } from '../src/note-read.ts'

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

type CapturedNoteChange = {
  table: string
  op: string
  expected_revision?: unknown
}

export const noteHostedChanges: CapturedNoteChange[] = []

export function resetNoteHostedChanges() {
  noteHostedChanges.length = 0
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
  revision: '1',
})

function noteBelongsToRequestedSpace(project: string, init?: RequestInit) {
  const space = new Headers(init?.headers).get(RECORD_SPACE_HEADER_NAME)
  return space === 'space-gamma' ? project === 'gamma' : project !== 'gamma'
}

async function getRoute(url: URL, at: string, init?: RequestInit) {
  if (url.pathname === '/v1/notes/candidates') {
    const project = url.searchParams.get('project') ?? ''
    const notes = await listNotes({ project, actionable: true }, { baseUrl: '' })
    return Response.json(
      noteDuplicateQuestionCandidates(
        notes.filter((note) => noteBelongsToRequestedSpace(note.project, init)),
        project,
        url.searchParams.get('text') ?? '',
      ).map(({ score: _score, ...note }) => ({
        record_id: note.record_id,
        number: note.number,
        label: note.label,
        project: note.project,
        text: note.text,
        stale_at: note.stale_at,
      })),
    )
  }
  if (url.pathname === '/v1/notes/list') {
    const notes = await listNotes(
      {
        project: url.searchParams.get('project') ?? undefined,
        stale: url.searchParams.has('stale') ? url.searchParams.get('stale') === 'true' : undefined,
        actionable: url.searchParams.get('actionable') === 'true',
        promotedTo: url.searchParams.get('promoted_to') ?? undefined,
        reference: url.searchParams.get('reference') ?? undefined,
        session: url.searchParams.getAll('session'),
        kept: url.searchParams.has('kept') ? url.searchParams.get('kept') === 'true' : undefined,
        text: url.searchParams.get('text') ?? undefined,
      },
      { baseUrl: '' },
    )
    const matching = notes.filter((note) => noteBelongsToRequestedSpace(note.project, init))
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
    return Response.json({
      notes: (limit === undefined ? matching : matching.slice(0, limit)).map((note) => ({
        record_id: note.record_id,
        label: note.label,
        number: note.number,
        project: note.project,
        text: note.text,
        sightings: note.sightings,
        created_at: note.created_at,
        last_seen_at: note.last_seen_at,
        stale_at: note.stale_at,
        stale_reason: note.stale_reason,
        promoted_task: note.promoted_task,
      })),
      total: matching.length,
    })
  }
  const noteMatch = /^\/v1\/notes\/([0-9a-f-]{36})$/i.exec(url.pathname)
  if (noteMatch) {
    try {
      const note = await getNote(noteMatch[1]!, { baseUrl: '' })
      if (!noteBelongsToRequestedSpace(note.project, init))
        return Response.json({ error: 'note not found' }, { status: 404 })
      return Response.json(shape(note, at))
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
  const selectedNotes = notes.filter((note) => noteBelongsToRequestedSpace(note.project, init))
  const selectedIds = new Set(selectedNotes.map((note) => note.record_id))
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
    .filter((row) => selectedIds.has(row.note_id))
    .map((row) => ({
      ...row,
      created_at: row.acknowledged_at,
      updated_at: row.acknowledged_at,
      deleted_at: null,
    }))
  return Response.json({
    notes: selectedNotes.map((note) => shape(note, at)),
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
    const changes = rawBody as Array<CapturedNoteChange & { id: string }>
    noteHostedChanges.push(...changes)
    return Response.json(changes.map((change) => ({ id: change.id, status: 'applied' })))
  }
  if (url.pathname.startsWith('/v1/notes') && init?.method === 'GET') return getRoute(url, at, init)
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
