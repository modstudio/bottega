import { beforeEach, expect, test } from 'bun:test'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { pullHostedNoteChanges } from './hosted-change-cache.ts'
import { createHostedNoteReferenceResolver } from './note.ts'

const workshop = declareFixtureProjectSpace('workshop', 'workshop')
beforeEach(resetFixtureStore)

const hostedNote = (number: number) => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  number,
  project: 'workshop',
  project_name: 'workshop',
  text: `Hosted note ${number}`,
  area: null,
  anchors: '[]',
  sightings: 1,
  created_at: '2026-11-24T00:00:00.000Z',
  last_seen_at: '2026-11-24T00:00:00.000Z',
  stale_at: null,
  stale_reason: null,
  promoted_task: null,
  updated_at: '2026-11-24T00:00:00.000Z',
  deleted_at: null,
  revision: 1,
})

test('a hosted miss pulls notes once and resolves every reference from the refreshed cache', async () => {
  const notes = [hostedNote(41), hostedNote(42)]
  const requests: string[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    requests.push(url.pathname)
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'space-workshop',
        memberships: [{ spaceId: 'space-workshop', slug: 'workshop', permission: 'write' }],
        capabilities: { projectNoteCounters: true, targetSpaceNotes: true },
      })
    if (url.pathname === '/v1/notes' && init?.method === 'GET')
      return Response.json({
        notes,
        acknowledgements: [],
        projectCounters: [{ project: 'workshop', next: 43 }],
        cursor: 'done',
        more: false,
      })
    throw new Error(`unexpected hosted note pull route ${url.pathname}`)
  }
  let pulls = 0
  const resolveReference = createHostedNoteReferenceResolver({
    hostedUrl: () => 'https://hub.example.test',
    pullNotes: async () => {
      pulls += 1
      await pullHostedNoteChanges({
        baseUrl: 'https://hub.example.test',
        token: 'test',
        fetch,
        registeredProjects: [workshop()],
      })
    },
  })

  expect(db().query('SELECT 1 FROM note').get()).toBeNull()
  expect(await resolveReference('41', 'workshop')).toBe(notes[0]!.id)
  expect(await resolveReference('42', 'workshop')).toBe(notes[1]!.id)
  expect(pulls).toBe(1)
  expect(requests.every((path) => path === '/v1/tasks/identity' || path === '/v1/notes')).toBe(true)
})

test('a hosted miss keeps the existing refusal when the pull does not bring the note', async () => {
  let pulls = 0
  const resolveReference = createHostedNoteReferenceResolver({
    hostedUrl: () => 'https://hub.example.test',
    pullNotes: async () => {
      pulls += 1
    },
  })

  await expect(resolveReference('99', 'workshop')).rejects.toThrow(
    'not visible in project workshop; pass the UUID or a <project>#<number> label',
  )
  expect(pulls).toBe(1)
})

test('a local install refuses without trying a hosted pull', async () => {
  let pulls = 0
  const resolveReference = createHostedNoteReferenceResolver({
    hostedUrl: () => undefined,
    pullNotes: async () => {
      pulls += 1
    },
  })

  await expect(resolveReference('99', 'workshop')).rejects.toThrow(
    'not visible in project workshop; pass the UUID or a <project>#<number> label',
  )
  expect(pulls).toBe(0)
})
