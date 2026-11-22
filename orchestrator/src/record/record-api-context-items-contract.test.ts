import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { redactSecretShaped } from '../../../shared/secret-shaped.ts'
import { idleRecordApiDeps, idleSubjectDeps } from '../../test/fixtures/record-api.ts'
import { recordApiTestApp } from '../../test/fixtures/record-api-app.ts'
import {
  DocRevisionConflictError,
  revisionConflictBodySchema,
} from '../doc/doc-revision-conflict.ts'
import { recordApiError } from './record-api-client-error.ts'
import { registerRecordContextItemRoutes } from './record-api-context-items.ts'
import { identity } from './record-api-identity.fixture.ts'
import type { RecordIdentity } from './record-auth.ts'

const contractRoutes = ['GET /v1/context-items', 'GET /v1/context-items/holders'] as const
const contractPath = (route: (typeof contractRoutes)[number]) => route.slice('GET '.length)

const readDeps = {
  readContextItems: async () => [],
  readContextHolders: async () => [],
}

test('context-item write stores fixture credentials masked', async () => {
  const secret = 'ghp_123456789012345678901234567890123456'
  const generic =
    'a key=value line with bearer prose and VGhpcyBpcyBhIGdlbmVyaWMgcHJvc2Ugc2FtcGxl'
  let storedBody = ''
  const app = recordApiTestApp(identity, {
    ...idleSubjectDeps(),
    ...idleRecordApiDeps(),
    upsertContextItem: async (input: { body: string }) => {
      storedBody = input.body
      return {}
    },
  })
  const response = await app.request('/v1/context-items', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
    body: JSON.stringify({
      holderKind: 'task',
      holderId: newRecordId(),
      slug: 'secret-reproduction',
      kind: 'fact',
      body: `${generic} quoted ${secret}`,
      source: 'test',
      questionNumber: null,
      target: null,
    }),
  })
  expect(response.status).toBe(200)
  expect(storedBody).toBe(
    `${generic} ${redactSecretShaped(`quoted ${secret}`, { precision: 'high' }).text}`,
  )
})

test('hosted context-item delete returns removed false when the row is absent', async () => {
  const id = newRecordId()
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordContextItemRoutes(
    app,
    {
      ...readDeps,
      upsertContextItem: async () => ({}),
      deleteContextItem: async () => ({ removed: false }),
    },
    {
      scope: () => ({
        url: 'postgres://unused.invalid/record',
        userId: newRecordId(),
        spaceId: newRecordId(),
        spaceIds: [],
      }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )
  const response = await app.request(`/v1/context-items/${id}`, { method: 'DELETE' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ removed: false })
})

test.each(['PUT', 'DELETE'])(
  'hosted context-item %s maps revision conflicts to 409',
  async (method) => {
    const id = newRecordId()
    const conflict = () => {
      throw new DocRevisionConflictError(
        `context item changed\ncleared by: re-read the item with ${PLATFORM_SLUG} agent context show, then retry with its current revision`,
        'context item changed',
        'stale-revision',
        'current-revision',
      )
    }
    const app = recordApiTestApp(identity, {
      ...idleSubjectDeps(),
      ...idleRecordApiDeps(),
      upsertContextItem: async () => conflict(),
      deleteContextItem: async () => conflict(),
    })
    const response = await app.request(
      method === 'PUT' ? '/v1/context-items' : `/v1/context-items/${id}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'x-record-space': 'space-a' },
        body: JSON.stringify(
          method === 'PUT'
            ? {
                holderKind: 'task',
                holderId: newRecordId(),
                slug: 'fact',
                kind: 'fact',
                body: 'Fact.',
                source: 'test',
                questionNumber: null,
                target: null,
                expectedRevision: 'stale-revision',
              }
            : { expectedRevision: 'stale-revision' },
        ),
      },
    )
    const body = await response.json()
    expect(response.status).toBe(409)
    expect(revisionConflictBodySchema.safeParse(body).success).toBe(true)
    expect(recordApiError(body, response.status).message).toContain(
      `${PLATFORM_SLUG} agent context show`,
    )
    expect(body).toMatchObject({
      code: 'revision-conflict',
      reason: 'stale-revision',
      currentRevision: 'current-revision',
      error: expect.stringContaining(`${PLATFORM_SLUG} agent context show`),
    })
  },
)

test('hosted context-item GET validates batches and forwards holders and slug', async () => {
  let received: unknown = null
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordContextItemRoutes(
    app,
    {
      ...readDeps,
      readContextItems: async (input) => {
        received = input
        return []
      },
      upsertContextItem: async () => ({}),
      deleteContextItem: async () => ({ removed: false }),
    },
    {
      scope: () => ({
        url: 'postgres://unused.invalid/record',
        userId: newRecordId(),
        spaceId: newRecordId(),
        spaceIds: [],
      }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )
  const holderId = newRecordId()
  const response = await app.request(
    `${contractPath(contractRoutes[0])}?holder=task:${holderId}&slug=probe`,
  )
  expect(response.status).toBe(200)
  expect(received).toMatchObject({
    holders: [{ holderKind: 'task', holderId }],
    slug: 'probe',
  })
})

test('hosted context-item holders GET validates kind and returns grouped holders', async () => {
  const grouped = [
    {
      holder: 'session:session-a',
      holderId: 'session-a',
      updatedAt: '2026-11-21T00:00:00.000Z',
      items: [],
    },
  ]
  let received: unknown = null
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordContextItemRoutes(
    app,
    {
      ...readDeps,
      readContextHolders: async (input) => {
        received = input
        return grouped
      },
      upsertContextItem: async () => ({}),
      deleteContextItem: async () => ({ removed: false }),
    },
    {
      scope: () => ({
        url: 'postgres://unused.invalid/record',
        userId: newRecordId(),
        spaceId: newRecordId(),
        spaceIds: [],
      }),
      noSpace: () => new Response(null, { status: 403 }),
    },
  )

  const response = await app.request(`${contractPath(contractRoutes[1])}?kind=session`)
  expect(response.status).toBe(200)
  expect(received).toMatchObject({ holderKind: 'session' })
  expect(await response.json()).toEqual(grouped)

  const invalid = await app.request(`${contractPath(contractRoutes[1])}?kind=invalid`)
  expect(invalid.status).toBe(400)
})

test('hosted context-item GET names the holder batch cap when exceeded', async () => {
  const app = recordApiTestApp(identity, {
    ...idleSubjectDeps(),
    ...idleRecordApiDeps(),
  })
  const search = new URLSearchParams()
  for (let index = 0; index < 101; index++) search.append('holder', `session:s-${index}`)
  const response = await app.request(`/v1/context-items?${search}`, {
    headers: { 'x-record-space': 'space-a' },
  })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('CONTEXT_ITEM_HOLDER_BATCH_LIMIT')
})
