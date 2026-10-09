import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { SubjectOutput } from '../../../shared/subjects.ts'
import { registerRecordSubjectRoutes } from './record-api-subjects.ts'
import type { RecordIdentity } from './record-auth.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }

const at = '2026-10-08T00:00:00.000Z'
const row = (definition: string): SubjectOutput => ({
  id: '01990000-0000-7000-8000-000000000001',
  project: 'alpha',
  name: 'One',
  definition,
  position: 0,
  parentId: null,
  state: 'active',
  retiredAt: null,
  createdAt: at,
  updatedAt: at,
})

describe('record subject API', () => {
  test('passes a trimmed definition and names the one-line rule for an interior break', async () => {
    const definitions: string[] = []
    const app = new Hono<Environment>()
    registerRecordSubjectRoutes(
      app,
      {
        listSubjects: async () => [],
        addSubject: async (input) => {
          definitions.push(input.definition)
          return row(input.definition)
        },
        defineSubject: async (input) => {
          definitions.push(input.definition)
          return row(input.definition)
        },
        renameSubject: async () => row('One subject.'),
        reorderSubjects: async () => [],
        retireSubject: async () => row('One subject.'),
      },
      {
        scope: () => ({
          url: 'postgres://unused.invalid/record',
          userId: '01990000-0000-7000-8000-000000000002',
          spaceId: '01990000-0000-7000-8000-000000000003',
          spaceIds: ['01990000-0000-7000-8000-000000000003'],
        }),
        noSpace: () => new Response(null, { status: 409 }),
      },
    )

    const added = await app.request('/v1/subjects', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: 'alpha',
        name: 'One',
        definition: '  One subject. \n',
      }),
    })
    expect(added.status).toBe(200)
    expect(definitions).toEqual(['One subject.'])

    const refused = await app.request('/v1/subjects/01990000-0000-7000-8000-000000000001/define', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'alpha', definition: 'First line\nSecond line' }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({
      error: 'a subject definition must be one non-empty line',
    })
    expect(definitions).toEqual(['One subject.'])
  })
})
