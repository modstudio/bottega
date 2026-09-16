import { describe, expect, test } from 'bun:test'
import { recordApi } from './record-api.ts'
import type { RecordIdentity } from './record-auth.ts'

const identity: RecordIdentity = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  memberships: [
    { space_id: 'space-a', name: 'Space A', slug: 'space-a', role: 'owner', permission: 'write' },
  ],
}

function appWith(session: RecordIdentity | null) {
  return recordApi({
    recordUrl: 'postgres://record.test/record',
    auth: { handler: () => Response.json({ handled: true }) },
    readSession: async () => session,
    readHealth: async () => ({ ok: true, migrations: 14 }),
    readRuns: async () => [],
  })
}

describe('record API', () => {
  test('refuses unauthenticated v1 requests with a sign-in remedy', async () => {
    const response = await appWith(null).request('/v1/whoami')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'record authentication required',
      remedy: 'record session is missing or expired; run `orch record sign-in --email <email>`',
    })
  })

  test('refuses a session without an active space', async () => {
    const response = await appWith({ ...identity, activeSpaceId: null }).request('/v1/whoami')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'record session has no active space',
      remedy: 'run `orch record space switch <slug>` to select an active space',
    })
  })

  test('returns the CLI whoami shape', async () => {
    const response = await appWith(identity).request('/v1/whoami')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(identity)
  })

  test('passes auth routes to Better Auth and reports shipped migrations', async () => {
    const app = appWith(identity)
    expect(await (await app.request('/api/auth/session')).json()).toEqual({ handled: true })
    expect(await (await app.request('/health')).json()).toEqual({ ok: true, migrations: 14 })
  })
})
