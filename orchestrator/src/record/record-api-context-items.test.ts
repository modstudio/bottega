import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  DocRevisionConflictError,
  revisionConflictBodySchema,
} from '../doc/doc-revision-conflict.ts'
import { recordApiError } from './record-api-client-error.ts'
import { registerRecordContextItemRoutes } from './record-api-context-items.ts'
import { renderRecordApiRefusal } from './record-api-errors.ts'
import type { RecordIdentity } from './record-auth.ts'

test('hosted context-item delete returns removed false when the row is absent', async () => {
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
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ removed: false })
})

test.each(['PUT', 'DELETE'])(
  'hosted context-item %s maps revision conflicts to 409',
  async (method) => {
    const id = newRecordId()
    const app = new Hono<{
      Variables: { identity: RecordIdentity; destinationSpaceId?: string }
    }>()
    app.onError(
      (error, context) => renderRecordApiRefusal(context, error) ?? context.text('error', 500),
    )
    const conflict = () => {
      throw new DocRevisionConflictError(
        'context item changed\ncleared by: re-read the item with bottega agent context show, then retry with its current revision',
        'context item changed',
        'stale-revision',
        'current-revision',
      )
    }
    registerRecordContextItemRoutes(
      app,
      {
        upsertContextItem: async () => conflict(),
        deleteContextItem: async () => conflict(),
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
    const response = await app.request(
      method === 'PUT' ? '/v1/context-items' : `/v1/context-items/${id}`,
      {
        method,
        headers: { 'content-type': 'application/json' },
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
    expect(recordApiError(body, response.status).message).toContain('bottega agent context show')
    expect(body).toMatchObject({
      code: 'revision-conflict',
      reason: 'stale-revision',
      currentRevision: 'current-revision',
      error: expect.stringContaining('bottega agent context show'),
    })
  },
)
