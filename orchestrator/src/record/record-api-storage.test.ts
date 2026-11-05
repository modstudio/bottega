import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordStorageRoute } from './record-api-storage.ts'
import type { RecordIdentity } from './record-auth.ts'

const identity = (id: string): RecordIdentity => ({
  user: { id },
  activeSpaceId: null,
  personalSpaceId: null,
  memberships: [],
})

test('hosted storage refuses a non-platform-owner and an empty allowlist', async () => {
  for (const allowed of [[], ['other']]) {
    const app = new Hono<{ Variables: { identity: RecordIdentity } }>()
    app.use('*', async (context, next) => {
      context.set('identity', identity('caller'))
      await next()
    })
    registerRecordStorageRoute(app, {
      platformOwnerUserIds: () => allowed,
      readStorage: async () => [],
    })
    const response = await app.request('/v1/storage')
    expect(response.status).toBe(403)
    if (!allowed.length) expect(await response.text()).toContain('BOTTEGA_PLATFORM_OWNER_USER_IDS')
  }
})
