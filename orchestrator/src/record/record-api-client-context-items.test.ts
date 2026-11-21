import { expect, test } from 'bun:test'
import {
  CONTEXT_ITEM_HOLDER_BATCH_LIMIT,
  RECORD_CONTEXT_ITEMS_ROUTE,
} from './record-api-client-paths.ts'
import { recordContextItemReadClient } from './record-api-client-context-items.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { RecordContextItem } from './record-context-items.ts'

function contextItem(holder: string): RecordContextItem {
  return {
    recordId: `record-${holder}`,
    holder,
    id: 'probe',
    kind: 'fact',
    body: holder,
    source: 'test',
    questionNumber: null,
    target: null,
    revision: '2026-11-21T00:00:00.000Z',
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
  }
}

function captureContextItemReads() {
  const calls: string[] = []
  const request = (async <T>(path: string) => {
    calls.push(path)
    const url = new URL(path, 'https://record.example.test')
    return url.searchParams.getAll('holder').map(contextItem) as T
  }) as RecordClientRequest
  return { calls, client: recordContextItemReadClient(request) }
}

test('context-item client keeps exactly the holder limit in one request', async () => {
  const { calls, client } = captureContextItemReads()
  const holders = Array.from(
    { length: CONTEXT_ITEM_HOLDER_BATCH_LIMIT },
    (_, index) => `session:s-${index}`,
  )

  expect((await client.listContextItems(holders, {})).map((item) => item.holder)).toEqual(holders)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toStartWith(`${RECORD_CONTEXT_ITEMS_ROUTE}?`)
})

test('context-item client splits one holder past the limit and returns every item in order', async () => {
  const { calls, client } = captureContextItemReads()
  const holders = Array.from(
    { length: CONTEXT_ITEM_HOLDER_BATCH_LIMIT + 1 },
    (_, index) => `task:t-${index}`,
  )

  expect((await client.listContextItems(holders, {})).map((item) => item.holder)).toEqual(holders)
  expect(calls).toHaveLength(2)
  expect(
    calls.map(
      (path) => new URL(path, 'https://record.example.test').searchParams.getAll('holder').length,
    ),
  ).toEqual([CONTEXT_ITEM_HOLDER_BATCH_LIMIT, 1])
})

test('context-item client makes no request for an empty holder batch', async () => {
  const { calls, client } = captureContextItemReads()

  expect(await client.listContextItems([], {})).toEqual([])
  expect(calls).toEqual([])
})
