import { beforeEach, expect, spyOn, test } from 'bun:test'
import { RECORD_IDENTITY_MEMO_MAX_AGE_MS } from '../../shared/config-read-memo.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { getNote, listNotes, listProjectSlimNotes } from './note-read.ts'

beforeEach(resetFixtureStore)

const identity = {
  userId: 'user-1',
  activeSpaceId: 'space-1',
  memberships: [{ spaceId: 'space-1', slug: 'declared-gamma-space', permission: 'write' }],
  capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
}

const crossSpaceIdentity = {
  userId: 'user-1',
  activeSpaceId: 'space-active',
  memberships: [
    { spaceId: 'space-active', slug: 'active', permission: 'write' },
    { spaceId: 'space-gamma', slug: 'declared-gamma-space', permission: 'write' },
  ],
  capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
}

const hostedNote = (id: string, project = 'gamma') => ({
  id,
  number: 7,
  project,
  project_name: project,
  text: 'Cross-space note',
  area: null,
  anchors: '[]',
  sightings: 1,
  created_at: '2026-11-21T09:00:00.000Z',
  last_seen_at: '2026-11-21T10:00:00.000Z',
  stale_at: null,
  stale_reason: null,
  promoted_task: null,
  updated_at: '2026-11-21T10:00:00.000Z',
  deleted_at: null,
  revision: 1,
})

function crossSpaceFetch(id: string) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity') return Response.json(crossSpaceIdentity)
    const space = new Headers(init?.headers).get('x-record-space')
    if (url.pathname === '/v1/notes')
      return Response.json({
        notes: space === 'space-gamma' ? [hostedNote(id)] : [],
        acknowledgements: [],
        cursor: '',
        more: false,
      })
    if (url.pathname === `/v1/notes/${id}` && space === 'space-gamma')
      return Response.json(hostedNote(id))
    return Response.json({ error: 'note not found' }, { status: 404 })
  }
}

test('a project-filtered hosted list reads the project destination space', async () => {
  const id = crypto.randomUUID()
  const rows = await listNotes(
    { project: 'gamma' },
    {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: crossSpaceFetch(id),
    },
  )

  expect(rows.map((row) => row.record_id)).toEqual([id])
})

test('a hosted get searches project destination spaces after the active space', async () => {
  const id = crypto.randomUUID()
  const requestedSpaces: Array<string | null> = []
  const fetch = crossSpaceFetch(id)

  const note = await getNote(id, {
    baseUrl: 'https://hub.example.test',
    token: 'test',
    fetch: async (input, init) => {
      if (new URL(input).pathname.startsWith('/v1/notes/'))
        requestedSpaces.push(new Headers(init?.headers).get('x-record-space'))
      return fetch(input, init)
    },
  })

  expect(note.record_id).toBe(id)
  expect(requestedSpaces.slice(0, 2)).toEqual(['space-active', 'space-gamma'])
})

test('a hosted get reports a missing note only after searching every pull space', async () => {
  const id = crypto.randomUUID()
  const requestedSpaces: Array<string | null> = []
  const fetch = crossSpaceFetch(crypto.randomUUID())

  await expect(
    getNote(id, {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input, init) => {
        if (new URL(input).pathname.startsWith('/v1/notes/'))
          requestedSpaces.push(new Headers(init?.headers).get('x-record-space'))
        return fetch(input, init)
      },
    }),
  ).rejects.toThrow(`no note ${id}`)
  expect(requestedSpaces).toEqual(['space-active', 'space-gamma'])
})

test('a project-filtered hosted list surfaces destination refusal without active-space fallback', async () => {
  let noteRequests = 0

  await expect(
    listNotes(
      { project: 'gamma' },
      {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        recordSpace: 'space-active',
        fetch: async (input) => {
          if (new URL(input).pathname === '/v1/tasks/identity')
            return Response.json({
              ...crossSpaceIdentity,
              memberships: crossSpaceIdentity.memberships.slice(0, 1),
            })
          noteRequests++
          return Response.json({ notes: [], acknowledgements: [], cursor: '', more: false })
        },
      },
    ),
  ).rejects.toThrow("project 'gamma' declares a record space the signed-in user is not a member of")
  expect(noteRequests).toBe(0)
})

test('an unfiltered hosted list unions the active and project destination spaces', async () => {
  const activeId = crypto.randomUUID()
  const gammaId = crypto.randomUUID()
  const requestedSpaces: Array<string | null> = []
  const rows = await listNotes(
    {},
    {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input, init) => {
        if (new URL(input).pathname === '/v1/tasks/identity')
          return Response.json(crossSpaceIdentity)
        const space = new Headers(init?.headers).get('x-record-space')
        requestedSpaces.push(space)
        const notes =
          space === 'space-active'
            ? [hostedNote(activeId, 'workshop')]
            : space === 'space-gamma'
              ? [hostedNote(gammaId)]
              : []
        return Response.json({ notes, acknowledgements: [], cursor: '', more: false })
      },
    },
  )

  expect(new Set(rows.map((row) => row.record_id))).toEqual(new Set([activeId, gammaId]))
  expect(requestedSpaces).toEqual(['space-active', 'space-gamma'])
})

test('an unfiltered hosted list requests its spaces concurrently', async () => {
  let started = 0
  let release: (() => void) | undefined
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve
  })

  await listNotes(
    {},
    {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) => {
        if (new URL(input).pathname === '/v1/tasks/identity')
          return Response.json(crossSpaceIdentity)
        started++
        if (started === 2) release?.()
        await bothStarted
        return Response.json({ notes: [], acknowledgements: [], cursor: '', more: false })
      },
    },
  )

  expect(started).toBe(2)
})

test('an unfiltered hosted list refuses a note id duplicated across spaces', async () => {
  const id = crypto.randomUUID()

  await expect(
    listNotes(
      {},
      {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async (input) =>
          new URL(input).pathname === '/v1/tasks/identity'
            ? Response.json(crossSpaceIdentity)
            : Response.json({
                notes: [hostedNote(id)],
                acknowledgements: [],
                cursor: '',
                more: false,
              }),
      },
    ),
  ).rejects.toThrow(`note ${id} appears in record spaces space-active and space-gamma`)
})

test('an unfiltered hosted slim list refuses a note id duplicated across spaces', async () => {
  const id = crypto.randomUUID()
  const note = hostedNote(id)

  await expect(
    listProjectSlimNotes({
      hosted: {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async (input) =>
          new URL(input).pathname === '/v1/tasks/identity'
            ? Response.json(crossSpaceIdentity)
            : Response.json({
                notes: [
                  {
                    record_id: note.id,
                    label: `${note.project}#${note.number}`,
                    number: note.number,
                    project: note.project,
                    text: note.text,
                    sightings: note.sightings,
                    created_at: note.created_at,
                    last_seen_at: note.last_seen_at,
                    stale_at: note.stale_at,
                    stale_reason: note.stale_reason,
                    promoted_task: note.promoted_task,
                  },
                ],
                total: 1,
              }),
      },
    }),
  ).rejects.toThrow(`note ${id} appears in record spaces space-active and space-gamma`)
})

test('an unfiltered hosted list names the space whose request fails', async () => {
  await expect(
    listNotes(
      {},
      {
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch: async (input, init) => {
          if (new URL(input).pathname === '/v1/tasks/identity')
            return Response.json(crossSpaceIdentity)
          const space = new Headers(init?.headers).get('x-record-space')
          return space === 'space-gamma'
            ? Response.json({ error: 'space read failed' }, { status: 500 })
            : Response.json({ notes: [], acknowledgements: [], cursor: '', more: false })
        },
      },
    ),
  ).rejects.toThrow('record space space-gamma:')
})

test('a hosted get does not fall back to a local-only note', async () => {
  const id = crypto.randomUUID()
  const at = '2026-11-21T10:00:00.000Z'
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO note(record_id,number,project,text,anchors,sightings,created_at,last_seen_at)
         VALUES (?,1,'workshop','local only','[]',1,?,?)`,
      )
      .run(id, at, at),
  )
  await expect(
    getNote(id, {
      baseUrl: 'https://hub.example.test',
      token: 'test',
      fetch: async (input) =>
        new URL(input).pathname === '/v1/tasks/identity'
          ? Response.json(identity)
          : Response.json({ error: 'note not found' }, { status: 404 }),
    }),
  ).rejects.toThrow(`no note ${id}`)
})

test('hosted list delegates server filters, applies client filters, sorts, and resolves identity once', async () => {
  const requested: string[] = []
  let identities = 0
  const note = (id: string, session: string, seen: string, text = 'needle') => ({
    id,
    number: Number(id.at(-1)),
    project: 'gamma',
    project_name: 'gamma',
    text,
    area: null,
    anchors: JSON.stringify([{ session_id: session }]),
    sightings: 1,
    created_at: '2026-11-21T09:00:00.000Z',
    last_seen_at: seen,
    stale_at: null,
    stale_reason: null,
    promoted_task: null,
    updated_at: seen,
    deleted_at: null,
  })
  const keptId = '01990000-0000-7000-8000-000000002521'
  const olderId = '01990000-0000-7000-8000-000000002522'
  const newerId = '01990000-0000-7000-8000-000000002523'
  const fetch = async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/v1/tasks/identity') {
      identities++
      return Response.json(identity)
    }
    requested.push(url.search)
    if (!url.searchParams.has('cursor'))
      return Response.json({
        notes: [
          note(keptId, 'session-a', '2026-11-21T12:00:00.000Z'),
          note(olderId, 'session-a', '2026-11-21T10:00:00.000Z'),
        ],
        acknowledgements: [
          {
            id: crypto.randomUUID(),
            note_id: keptId,
            project_name: 'gamma',
            session_id: 'session-a',
            acknowledged_at: '2026-11-21T12:01:00.000Z',
            sightings: 1,
            created_at: '2026-11-21T12:01:00.000Z',
            updated_at: '2026-11-21T12:01:00.000Z',
            deleted_at: null,
          },
        ],
        cursor: 'next',
        more: true,
      })
    return Response.json({
      notes: [
        note(newerId, 'session-a', '2026-11-21T11:00:00.000Z'),
        note(crypto.randomUUID(), 'other-session', '2026-11-21T13:00:00.000Z'),
        note(crypto.randomUUID(), 'session-a', '2026-11-21T14:00:00.000Z', 'other text'),
      ],
      acknowledgements: [],
      cursor: 'done',
      more: false,
    })
  }
  const rows = await listNotes(
    {
      project: 'gamma',
      stale: false,
      actionable: true,
      session: 'session-a',
      kept: false,
      text: 'needle',
    },
    { baseUrl: 'https://hub.example.test', token: 'test', fetch },
  )
  expect(rows.map((row) => row.record_id)).toEqual([newerId, olderId])
  expect(requested).toHaveLength(2)
  for (const query of requested) {
    const params = new URLSearchParams(query)
    expect(params.get('project')).toBe('gamma')
    expect(params.get('stale')).toBe('false')
    expect(params.get('actionable')).toBe('true')
  }
  expect(identities).toBe(1)
})

test('hosted note identity is reloaded after the record identity memo max age', async () => {
  let now = 1_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  let identities = 0
  const fetch = async (input: string) => {
    if (new URL(input).pathname === '/v1/tasks/identity') {
      identities++
      return Response.json(identity)
    }
    return Response.json({ notes: [], acknowledgements: [], cursor: '', more: false })
  }
  const options = { baseUrl: 'https://hub.example.test', token: 'test', fetch }

  try {
    await listNotes({ project: 'gamma' }, options)
    now += RECORD_IDENTITY_MEMO_MAX_AGE_MS - 1
    await listNotes({ project: 'gamma' }, options)
    expect(identities).toBe(1)

    now++
    await listNotes({ project: 'gamma' }, options)
    expect(identities).toBe(2)
  } finally {
    clock.mockRestore()
  }
})
