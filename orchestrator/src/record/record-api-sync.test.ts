import { expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { identity } from '../../test/fixtures/record-api.ts'
import { registerRecordSyncRoute } from './record-api-sync.ts'
import {
  RECORD_SYNC_MAX_PAYLOAD_BYTES,
  RECORD_SYNC_MAX_REQUEST_BYTES,
} from './record-sync-contract.ts'
import { RecordSyncRequestRefusal } from './record-sync-decision.ts'

const id = '01990000-0000-7000-8000-000000000001'

test('sync forwards raw payloads with the authenticated identity and enforces byte limits', async () => {
  const syncRecord = mock(async (input: { request: { rows: Array<{ id: number }> } }) => ({
    results: input.request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
  }))
  const app = new Hono<{
    Variables: { identity: typeof identity; destinationSpaceId?: string }
  }>()
  app.use('*', async (context, next) => {
    context.set('identity', identity)
    await next()
  })
  registerRecordSyncRoute(app, {
    recordUrl: 'postgres://record.test/record',
    syncRecord,
  })
  const request = {
    machine: { id, name: 'fixture', seenAt: '2026-10-13T12:00:00.000Z' },
    rows: [{ id: 1, kind: 'run', payload: '{"raw":true}', spaceHint: null }],
  }
  expect(
    (await app.request('/v1/sync', { method: 'POST', body: JSON.stringify(request) })).status,
  ).toBe(200)
  expect(syncRecord).toHaveBeenCalledWith(
    expect.objectContaining({ identity, request: expect.objectContaining({ rows: request.rows }) }),
  )

  request.rows[0]!.payload = 'x'.repeat(RECORD_SYNC_MAX_PAYLOAD_BYTES + 1)
  expect(
    (await app.request('/v1/sync', { method: 'POST', body: JSON.stringify(request) })).status,
  ).toBe(413)
  expect(
    (
      await app.request('/v1/sync', {
        method: 'POST',
        body: 'x'.repeat(RECORD_SYNC_MAX_REQUEST_BYTES + 1),
      })
    ).status,
  ).toBe(413)
  expect(syncRecord).toHaveBeenCalledTimes(1)
})

test('sync returns request refusals and the active-space remedy as client errors', async () => {
  const request = {
    machine: { id, name: 'fixture', seenAt: '2026-10-13T12:00:00.000Z' },
    rows: [],
  }
  const app = new Hono<{
    Variables: { identity: typeof identity; destinationSpaceId?: string }
  }>()
  let currentIdentity = identity
  app.use('*', async (context, next) => {
    context.set('identity', currentIdentity)
    await next()
  })
  const syncRecord = mock(async () => {
    throw new RecordSyncRequestRefusal(
      'machine is registered to another user; sign in as its owner',
    )
  })
  registerRecordSyncRoute(app, { recordUrl: 'postgres://record.test/record', syncRecord })

  const refused = await app.request('/v1/sync', {
    method: 'POST',
    body: JSON.stringify(request),
  })
  expect(refused.status).toBe(409)
  expect(await refused.json()).toEqual({
    error: 'machine is registered to another user; sign in as its owner',
  })

  currentIdentity = { ...identity, activeSpaceId: null }
  const noSpace = await app.request('/v1/sync', {
    method: 'POST',
    body: JSON.stringify(request),
  })
  expect(noSpace.status).toBe(409)
  expect(await noSpace.json()).toEqual({
    error: `record session has no active space; run \`${PLATFORM_SLUG} record space switch <slug>\``,
  })
  expect(syncRecord).toHaveBeenCalledTimes(1)
})
