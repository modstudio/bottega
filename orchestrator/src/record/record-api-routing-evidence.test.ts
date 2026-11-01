import { expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { identity } from '../../test/fixtures/record-api.ts'
import {
  type RoutingEvidenceRouteDeps,
  registerRecordRoutingEvidenceRoute,
} from './record-api-routing-evidence.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordCursorAt } from './record-cursor.ts'

type ApiEnvironment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }

test('routing evidence binds the requested space and pages without exposing its cursor field', async () => {
  const spaceId = '01990000-0000-7000-8000-000000002013'
  const row = {
    id: '01990000-0000-7000-8000-000000002018',
    spaceId,
    agent: 'codex',
    model: null,
    job: 'implement',
    stack: null,
    promptBytes: 1,
    status: 'ok',
    failureKind: null,
    executor: 'external' as const,
    evidenceExcluded: null,
    startedAt: '2026-11-01T15:00:00.000Z',
    latencyMs: null,
    vendorTokens: null,
    modelCalls: null,
    peakCallTokens: null,
    delivery: null,
    quality: null,
    fidelity: null,
    lenses: [],
    [recordCursorAt]: '2026-11-01T16:00:00.000Z',
  }
  const listRoutingEvidence = mock(async () => [row, { ...row, id: row.spaceId }])
  const deps: RoutingEvidenceRouteDeps = {
    recordUrl: 'postgres://record.test/record',
    listRoutingEvidence,
  }
  const app = new Hono<ApiEnvironment>()
  app.use('*', async (context, next) => {
    context.set('identity', identity)
    await next()
  })
  registerRecordRoutingEvidenceRoute(app, deps)

  const response = await app.request(`/v1/routing-evidence?spaceId=${spaceId}&limit=1`)
  expect(response.status).toBe(200)
  const page = (await response.json()) as { items: unknown[]; nextCursor: string | null }
  const { [recordCursorAt]: _cursor, ...projected } = row
  expect(page.items).toEqual([projected])
  expect(page.nextCursor).not.toBeNull()
  expect(listRoutingEvidence).toHaveBeenCalledWith(
    expect.objectContaining({ spaceId, userId: identity.user.id, limit: 1, cursor: null }),
  )
  expect((await app.request(`/v1/routing-evidence?spaceId=${spaceId}&limit=101`)).status).toBe(400)
})
