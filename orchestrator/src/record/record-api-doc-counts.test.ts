import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordDocCountsRoute } from './record-api-doc-counts.ts'
import type { RecordIdentity } from './record-auth.ts'

const app = () => {
  const server = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordDocCountsRoute(
    server,
    {
      countDocs: async () => ({ docs: 4, revisions: 0 }),
      countScores: async () => ({ scores: 0, voids: 0 }),
      countCacheRows: async () => ({
        byScope: [
          { scope: 'global', project: null, docs: 1 },
          { scope: 'project', project: 'alpha', docs: 1 },
          { scope: 'project', project: 'beta', docs: 1 },
        ],
        subjectsByProject: [
          { project: 'alpha', subjects: 2 },
          { project: 'beta', subjects: 1 },
        ],
      }),
    },
    {
      scope: () => ({
        url: 'postgres://unused',
        userId: 'user-a',
        spaceId: 'space-a',
        spaceIds: ['space-a'],
      }),
      noSpace: () => new Response(),
    },
  )
  return server
}

test('scope count keys are returned only when requested', async () => {
  const oldResponse = await app().request('/v1/docs/counts')
  expect(await oldResponse.json()).toEqual({ docs: 4, revisions: 0, scores: 0, voids: 0 })

  const groupedResponse = await app().request('/v1/docs/counts?by=scope')
  expect(await groupedResponse.json()).toMatchObject({
    byScope: expect.any(Array),
    subjectsByProject: expect.any(Array),
  })
})
