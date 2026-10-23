import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../../shared/brand.ts'
import { recordRouter } from './record.ts'

const spaceId = '01990000-0000-7000-8000-000000000001'
const userId = '01990000-0000-7000-8000-000000000002'
const subscriptionId = '01990000-0000-7000-8000-000000000003'
const revisionId = '01990000-0000-7000-8000-000000000004'
const originalFetch = globalThis.fetch
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const originalRecordDatabaseUrl = process.env.BOTTEGA_RECORD_DATABASE_URL

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
  if (originalRecordDatabaseUrl === undefined) delete process.env.BOTTEGA_RECORD_DATABASE_URL
  else process.env.BOTTEGA_RECORD_DATABASE_URL = originalRecordDatabaseUrl
})

function caller(permission: 'read' | 'write') {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  delete process.env.BOTTEGA_RECORD_DATABASE_URL
  globalThis.fetch = (async () =>
    Response.json({
      user: { id: userId },
      activeSpaceId: spaceId,
      personalSpaceId: null,
      memberships: [{ space_id: spaceId, slug: 'acme', permission }],
    })) as unknown as typeof fetch
  return recordRouter.createCaller({ authorization: 'Bearer token' })
}

test('hosted document mutations bind the destination, authenticated author, and revision', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const requests: Array<{ path: string; init: RequestInit }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/whoami') {
      return Response.json({
        user: { id: userId },
        activeSpaceId: spaceId,
        personalSpaceId: null,
        memberships: [{ space_id: spaceId, slug: 'acme', permission: 'write' }],
      })
    }
    requests.push({ path, init: init ?? {} })
    return Response.json({ id: spaceId, revisionId })
  }) as typeof fetch
  const api = recordRouter.createCaller({ authorization: 'Bearer token' })

  const saved = await api.saveDoc({
    spaceId,
    scope: 'project',
    subject: PLATFORM_NAME,
    slug: 'guide',
    title: 'Guide',
    body: 'Body',
    reason: 'save it',
    expectedRevision: revisionId,
  })
  await api.deleteDoc({ id: spaceId, spaceId, reason: 'remove it', expectedRevision: revisionId })

  expect(requests).toHaveLength(2)
  expect(requests.map(({ init }) => new Headers(init.headers).get('x-record-space'))).toEqual([
    spaceId,
    spaceId,
  ])
  expect(requests.map(({ init }) => JSON.parse(String(init.body)))).toEqual([
    {
      scope: 'project',
      subject: PLATFORM_NAME,
      slug: 'guide',
      title: 'Guide',
      body: 'Body',
      reason: 'save it',
      expectedRevision: revisionId,
      author: userId,
    },
    { author: userId, expectedRevision: revisionId, reason: 'remove it' },
  ])
  expect(saved).toEqual({ revision: revisionId })
})

test('hosted document reorder binds the destination and complete sibling order', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  let request: { path: string; init: RequestInit } | null = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = { path: new URL(String(input)).pathname, init: init ?? {} }
    return Response.json({ orderedIds: [spaceId] })
  }) as typeof fetch
  const api = recordRouter.createCaller({ authorization: 'Bearer token' })

  expect(
    await api.reorderDocs({
      spaceId,
      scope: 'project',
      subject: PLATFORM_NAME,
      parentId: null,
      orderedIds: [spaceId],
    }),
  ).toEqual({ orderedIds: [spaceId] })
  expect(request).not.toBeNull()
  expect(request!.path).toBe('/v1/docs/order')
  expect(new Headers(request!.init.headers).get('x-record-space')).toBe(spaceId)
})

test('hosted document save sends explicit article clears and refuses invalid fields at the edge', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  let savedBody: unknown
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/whoami') {
      return Response.json({
        user: { id: userId },
        activeSpaceId: spaceId,
        personalSpaceId: null,
        memberships: [{ space_id: spaceId, slug: 'acme', permission: 'write' }],
      })
    }
    savedBody = JSON.parse(String(init?.body))
    return Response.json({ id: spaceId, revisionId })
  }) as typeof fetch
  const api = recordRouter.createCaller({ authorization: 'Bearer token' })
  await api.saveDoc({
    spaceId,
    scope: 'project',
    subject: PLATFORM_NAME,
    slug: 'guide',
    title: 'Guide',
    body: 'Body',
    reason: 'clear article fields',
    expectedRevision: revisionId,
    parentRecordId: null,
    form: null,
    articleSubjectId: null,
    relatedSubjectIds: [],
    sourceFiles: [],
  })
  expect(savedBody).toEqual({
    scope: 'project',
    subject: PLATFORM_NAME,
    slug: 'guide',
    title: 'Guide',
    body: 'Body',
    reason: 'clear article fields',
    expectedRevision: revisionId,
    parentRecordId: null,
    form: null,
    articleSubjectId: null,
    relatedSubjectIds: [],
    sourceFiles: [],
    author: userId,
  })
  await expect(
    api.saveDoc({
      spaceId,
      scope: 'project',
      subject: PLATFORM_NAME,
      slug: 'guide',
      title: 'Guide',
      body: 'Body',
      reason: 'invalid form',
      expectedRevision: revisionId,
      form: 'essay' as 'feature',
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('feature') })
})

test('hosted subject choices read the destination space through the record client', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  let request: { url: string; space: string | null } | undefined
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = {
      url: String(input),
      space: new Headers(init?.headers).get('x-record-space'),
    }
    return Response.json({ items: [], nextCursor: null })
  }) as typeof fetch
  const api = recordRouter.createCaller({ authorization: 'Bearer token' })
  expect(await api.subjects({ spaceId, project: PLATFORM_NAME })).toEqual([])
  expect(request).toEqual({
    url: `https://record.example.test/v1/subjects?project=${encodeURIComponent(PLATFORM_NAME)}&limit=500`,
    space: spaceId,
  })
})

const mutations = [
  {
    name: 'create report subscription',
    call: (api: ReturnType<typeof caller>) =>
      api.createReportSubscription({
        cadence: 'daily',
        hour: 9,
        zone: 'UTC',
        enabled: true,
        scope: { kind: 'space' },
        recipientUserIds: [],
        recipientEmails: [],
      }),
  },
  {
    name: 'update report subscription',
    call: (api: ReturnType<typeof caller>) =>
      api.updateReportSubscription({
        id: subscriptionId,
        cadence: 'daily',
        hour: 9,
        zone: 'UTC',
        enabled: true,
        scope: { kind: 'space' },
        recipientUserIds: [],
        recipientEmails: [],
      }),
  },
  {
    name: 'remove report subscription',
    call: (api: ReturnType<typeof caller>) => api.removeReportSubscription({ id: subscriptionId }),
  },
  {
    name: 'send report subscription test',
    call: (api: ReturnType<typeof caller>) =>
      api.sendReportSubscriptionTest({ id: subscriptionId }),
  },
]

for (const mutation of mutations) {
  test(`read member is refused by the ${mutation.name} procedure`, async () => {
    // Production break watched: use hostedIdentity(ctx) for this mutation.
    await expect(mutation.call(caller('read'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: `record space ${spaceId} membership is read-only\nA space owner or admin can change the membership permission.`,
    })
  })

  test(`write member passes the ${mutation.name} procedure access check`, async () => {
    // Production break watched: refuse every membership without considering permission = 'write'.
    await expect(mutation.call(caller('write'))).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'BOTTEGA_RECORD_DATABASE_URL is required',
    })
  })
}
