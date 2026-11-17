import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { OUTBOX_HELD_FOR_UPGRADE_MARKER } from './outbox-held-contract.ts'
import { RETIRED_OUTBOX_REASON, syncHostedRecord } from './record-sync-service.ts'

const SPACE = '01990000-0000-7000-8000-000000002390'

function stubPostgres(): SQL {
  type Stub = SQL & {
    begin: <T>(callback: (sql: SQL) => Promise<T>) => Promise<T>
    unsafe: (query: string) => Promise<Record<string, unknown>[]>
  }
  const result = [{ id: SPACE, user_id: SPACE, name: 'kind-skew' }]
  const stub = (() => Promise.resolve(result)) as unknown as Stub
  stub.begin = (callback) => callback(stub)
  stub.unsafe = () => Promise.resolve(result)
  return stub
}

async function syncKind(kind: string) {
  return syncHostedRecord({
    url: 'postgres://unused',
    postgres: stubPostgres(),
    identity: {
      user: { id: SPACE },
      activeSpaceId: SPACE,
      personalSpaceId: SPACE,
      memberships: [{ space_id: SPACE, slug: 'kind-skew', permission: 'write' }],
    },
    request: {
      machine: { id: SPACE, name: 'kind-skew', seenAt: '2026-11-17T00:00:00.000Z' },
      rows: [{ id: 1, kind, payload: '{}', spaceHint: null }],
    },
  })
}

test('an unknown outbox kind is held for a hosted API upgrade', async () => {
  const result = await syncKind('kind_from_a_newer_client')
  expect(result).toEqual({
    results: [
      {
        id: 1,
        status: 'held',
        reason: expect.stringMatching(
          new RegExp(`^${OUTBOX_HELD_FOR_UPGRADE_MARKER}.*kind_from_a_newer_client`),
        ),
      },
    ],
  })
})

test('a retired outbox kind is quarantined with the retirement reason', async () => {
  expect(await syncKind('question')).toEqual({
    results: [{ id: 1, status: 'quarantined', reason: RETIRED_OUTBOX_REASON }],
  })
})
