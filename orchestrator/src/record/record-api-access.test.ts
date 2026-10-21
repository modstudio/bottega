import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordAccessRoutes } from './record-api-access.ts'

test('serves client addresses without authentication', async () => {
  const app = new Hono()
  registerRecordAccessRoutes(app, {
    clientAddresses: {
      recordApiUrl: 'https://api.example.test',
      hubHostedUrl: 'https://app.example.test',
    },
    auth: { handler: () => Response.json({ handled: true }) },
    readHealth: async () => ({ ok: true, migrations: 1 }),
    readVersion: () => ({ status: 200, body: {} }),
  })
  const response = await app.request('/client-config')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    recordApiUrl: 'https://api.example.test',
    hubHostedUrl: 'https://app.example.test',
  })
})
