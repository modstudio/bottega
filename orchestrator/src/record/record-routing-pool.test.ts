import { afterEach, expect, test } from 'bun:test'
import {
  installRecordApiClient,
  unusedBoardClientMethods,
  unusedIdentityAndSpaceClientMethods,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { RecordApiClient } from './record-api-client.ts'
import type { RecordRoutingEvidence } from './record-routing-evidence-contract.ts'
import {
  pullRoutingPool,
  ROUTING_POOL_PAGE_LIMIT,
  ROUTING_POOL_PAGES_PER_SYNC,
} from './record-routing-pool.ts'

afterEach(() => installRecordApiClient(null))

function evidence(
  id: string,
  spaceId: string,
  overrides: Partial<RecordRoutingEvidence> = {},
): RecordRoutingEvidence {
  return {
    id,
    spaceId,
    agent: 'codex',
    model: 'gpt-6',
    job: 'implement',
    stack: 'typescript',
    promptBytes: 1000,
    status: 'ok',
    failureKind: null,
    executor: 'external',
    evidenceExcluded: null,
    startedAt: '2026-11-01T12:00:00.000Z',
    latencyMs: 100,
    vendorTokens: 200,
    modelCalls: 1,
    peakCallTokens: 200,
    delivery: 'complete',
    quality: 'accepted',
    fidelity: 'faithful',
    lenses: ['architecture'],
    ...overrides,
  }
}

function installRoutingClient(listRoutingEvidence: RecordApiClient['listRoutingEvidence']): void {
  installRecordApiClient({
    ...unusedIdentityAndSpaceClientMethods(),
    ...unusedBoardClientMethods(),
    listRoutingEvidence,
  } as RecordApiClient)
}

function routingCursor(index: number): string {
  return btoa(String(index + 1))
}

test('routing pool caps pages, stores its cursor, and resumes to a final page', async () => {
  const calls: { cursor?: string | null; limit?: number }[] = []
  const rows = Array.from({ length: ROUTING_POOL_PAGES_PER_SYNC + 2 }, (_, index) =>
    evidence(`run-${index}`, 'space-a'),
  )
  installRoutingClient(async (query) => {
    calls.push({ cursor: query.cursor, limit: query.limit })
    const index = query.cursor ? Number(atob(query.cursor)) : 0
    const endCursor = routingCursor(index)
    return {
      items: [rows[index]!],
      nextCursor: index === rows.length - 1 ? null : endCursor,
      endCursor,
    }
  })

  expect(await pullRoutingPool(db(), ['space-a'])).toEqual({
    added: ROUTING_POOL_PAGES_PER_SYNC,
    updated: 0,
    caughtUp: false,
  })
  expect(calls).toHaveLength(ROUTING_POOL_PAGES_PER_SYNC)
  expect(calls.every((call) => call.limit === ROUTING_POOL_PAGE_LIMIT)).toBe(true)
  expect(
    db()
      .query<{ value: string }, []>(
        "SELECT value FROM schema_meta WHERE key='record_routing_pool_seq:space-a'",
      )
      .get()?.value,
  ).toBe(routingCursor(ROUTING_POOL_PAGES_PER_SYNC - 1))

  expect(await pullRoutingPool(db(), ['space-a'])).toEqual({
    added: 2,
    updated: 0,
    caughtUp: true,
  })
  expect(calls[ROUTING_POOL_PAGES_PER_SYNC]?.cursor).toBe(
    routingCursor(ROUTING_POOL_PAGES_PER_SYNC - 1),
  )
  expect(calls).toHaveLength(ROUTING_POOL_PAGES_PER_SYNC + 2)
})

test('routing pool overwrites hosted rows and replaces their lenses', async () => {
  let row = evidence('run-updated', 'space-a')
  installRoutingClient(async () => ({
    items: [row],
    nextCursor: null,
    endCursor: routingCursor(0),
  }))
  expect(await pullRoutingPool(db(), ['space-a'])).toEqual({
    added: 1,
    updated: 0,
    caughtUp: true,
  })

  row = evidence('run-updated', 'space-a', {
    quality: 'rejected',
    latencyMs: 250,
    lenses: ['fidelity'],
  })
  expect(await pullRoutingPool(db(), ['space-a'])).toEqual({
    added: 0,
    updated: 1,
    caughtUp: true,
  })
  expect(
    db()
      .query<{ quality: string; latency_ms: number }, []>(
        "SELECT quality,latency_ms FROM routing_pool_run WHERE record_id='run-updated'",
      )
      .get(),
  ).toEqual({ quality: 'rejected', latency_ms: 250 })
  expect(
    db()
      .query<{ lens: string }, []>(
        "SELECT lens FROM routing_pool_lens WHERE run_record_id='run-updated' ORDER BY lens",
      )
      .all(),
  ).toEqual([{ lens: 'fidelity' }])
})

test('routing pool keeps a separate cursor for every readable space', async () => {
  installRoutingClient(async ({ spaceId, cursor }) => ({
    items: [evidence(`run-${spaceId}`, spaceId)],
    nextCursor: null,
    endCursor: cursor ?? routingCursor(spaceId === 'space-a' ? 0 : 1),
  }))
  expect(await pullRoutingPool(db(), ['space-a', 'space-b'])).toEqual({
    added: 2,
    updated: 0,
    caughtUp: true,
  })
  expect(
    db()
      .query<{ key: string; value: string }, []>(
        "SELECT key,value FROM schema_meta WHERE key LIKE 'record_routing_pool_seq:%' ORDER BY key",
      )
      .all(),
  ).toEqual([
    {
      key: 'record_routing_pool_seq:space-a',
      value: routingCursor(0),
    },
    {
      key: 'record_routing_pool_seq:space-b',
      value: routingCursor(1),
    },
  ])
})

test('routing pool persists nextCursor when the hosted API omits endCursor', async () => {
  const calls: { cursor?: string | null }[] = []
  installRoutingClient(async (query) => {
    calls.push({ cursor: query.cursor })
    if (calls.length > ROUTING_POOL_PAGES_PER_SYNC) return { items: [], nextCursor: null }
    return {
      items: [evidence(`run-${calls.length}`, 'space-a')],
      nextCursor: routingCursor(calls.length),
    }
  })

  expect(await pullRoutingPool(db(), ['space-a'])).toEqual({
    added: ROUTING_POOL_PAGES_PER_SYNC,
    updated: 0,
    caughtUp: false,
  })
  expect(
    db()
      .query<{ value: string }, []>(
        "SELECT value FROM schema_meta WHERE key='record_routing_pool_seq:space-a'",
      )
      .get()?.value,
  ).toBe(routingCursor(ROUTING_POOL_PAGES_PER_SYNC))

  expect(await pullRoutingPool(db(), ['space-a'])).toEqual({
    added: 0,
    updated: 0,
    caughtUp: true,
  })
  expect(calls[ROUTING_POOL_PAGES_PER_SYNC]?.cursor).toBe(
    routingCursor(ROUTING_POOL_PAGES_PER_SYNC),
  )
})
