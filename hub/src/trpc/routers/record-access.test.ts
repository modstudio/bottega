import { afterEach, expect, test } from 'bun:test'
import { recordRouter } from './record.ts'

const spaceId = '01990000-0000-7000-8000-000000000001'
const userId = '01990000-0000-7000-8000-000000000002'
const subscriptionId = '01990000-0000-7000-8000-000000000003'
const originalFetch = globalThis.fetch
const originalRecordApiUrl = process.env.HUB_RECORD_API_URL
const originalRecordDatabaseUrl = process.env.HUB_RECORD_DATABASE_URL

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalRecordApiUrl === undefined) delete process.env.HUB_RECORD_API_URL
  else process.env.HUB_RECORD_API_URL = originalRecordApiUrl
  if (originalRecordDatabaseUrl === undefined) delete process.env.HUB_RECORD_DATABASE_URL
  else process.env.HUB_RECORD_DATABASE_URL = originalRecordDatabaseUrl
})

function caller(permission: 'read' | 'write') {
  process.env.HUB_RECORD_API_URL = 'https://record.example.test'
  delete process.env.HUB_RECORD_DATABASE_URL
  globalThis.fetch = (async () =>
    Response.json({
      user: { id: userId },
      activeSpaceId: spaceId,
      personalSpaceId: null,
      memberships: [{ space_id: spaceId, slug: 'acme', permission }],
    })) as unknown as typeof fetch
  return recordRouter.createCaller({ authorization: 'Bearer token' })
}

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
      message: 'HUB_RECORD_DATABASE_URL is required',
    })
  })
}
