import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record-id.ts'
import type { RecordIdentity } from './record-auth.ts'
import { registerRecordContextItemRoutes } from './record-api-context-items.ts'

test('hosted context-item delete returns a named 404 when the row is absent', async () => {
  const id = newRecordId()
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  registerRecordContextItemRoutes(
    app,
    {
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
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: `context item ${id} not found` })
})
