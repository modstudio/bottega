import { expect, test } from 'bun:test'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import { identity } from './record-api-identity.fixture.ts'

const contractRoutes = ['GET /v1/doc-revisions/:revisionId'] as const

const revisionId = '01990000-0000-7000-8000-000000000501'

test('a revision outside the caller readable spaces is not found', async () => {
  const app = recordApiTestApp(
    identity,
    { ...idleSubjectDeps(), ...idleRecordApiDeps() },
    {
      readDocRevision: async (input: { spaceIds: string[] }) =>
        input.spaceIds.includes('space-b')
          ? { id: revisionId, docId: '01990000-0000-7000-8000-000000000502', body: 'secret' }
          : null,
    },
  )

  const response = await app.request(`/v1/doc-revisions/${revisionId}`)
  expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toContain(contractRoutes[0])
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'doc revision not found' })
})
