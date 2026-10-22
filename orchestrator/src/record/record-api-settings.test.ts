import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordSettingsRoutes } from './record-api-settings.ts'
import type { RecordIdentity } from './record-auth.ts'

test('the auto-mode route refuses a malformed body before applying it', async () => {
  const app = new Hono<{ Variables: { identity: RecordIdentity } }>()
  let applied = false
  registerRecordSettingsRoutes(
    app,
    {
      applySettingsPermission: async () => {
        throw new Error('unused')
      },
      applySettingsAutoMode: async () => {
        applied = true
        throw new Error('must not apply')
      },
    },
    {
      scope: () => ({ url: '', userId: 'user', spaceId: 'space', spaceIds: ['space'] }),
      noSpace: () => Response.json({}, { status: 403 }),
      writeError: (_context, error) => Response.json({ error: String(error) }, { status: 500 }),
    },
  )
  const response = await app.request('/v1/settings/auto-mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: { kind: 'user' },
      list: 'unknown',
      rule: 'Bash(docker compose *)',
      operation: 'add',
      reason: 'test edit',
      expectedRevision: '01990000-0000-7000-8000-000000000010',
    }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid settings auto-mode edit' })
  expect(applied).toBe(false)
})
