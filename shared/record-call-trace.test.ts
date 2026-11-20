import { expect, test } from 'bun:test'
import {
  parseServerTiming,
  type RecordCallTrace,
  recordRouteClass,
  summarizeRecordCalls,
  tracedRecordFetch,
} from './record-call-trace.ts'

test('server timing parser reads app duration and rejects absent or malformed values', () => {
  expect(parseServerTiming('cache;desc="hit", app;dur=12.75')).toBe(12.75)
  expect(parseServerTiming(null)).toBeNull()
  expect(parseServerTiming('app;dur=not-a-number')).toBeNull()
  expect(parseServerTiming('database;dur=8')).toBeNull()
})

test('record call summaries aggregate each route and the formatted total', () => {
  const calls: RecordCallTrace[] = [
    {
      routeClass: 'record-docs',
      method: 'GET',
      status: 200,
      requestBytes: 0,
      responseBytes: 120,
      clientMs: 8.25,
      serverMs: 3.5,
      open: false,
      finish: 'complete',
    },
    {
      routeClass: 'record-docs',
      method: 'GET',
      status: 404,
      requestBytes: 0,
      responseBytes: 30,
      clientMs: 5,
      serverMs: null,
      open: false,
      finish: 'complete',
    },
    {
      routeClass: 'record-tasks',
      method: 'POST',
      status: 200,
      requestBytes: 10,
      responseBytes: null,
      clientMs: 2,
      serverMs: 1,
      open: false,
      finish: 'error',
    },
  ]

  expect(summarizeRecordCalls(calls)).toEqual([
    {
      routeClass: 'record-docs',
      count: 2,
      responseBytesTotal: 150,
      responseBytesMax: 120,
      clientMsTotal: 13.25,
      clientMsMax: 8.25,
      serverMsTotal: 3.5,
      serverMsMax: 3.5,
      open: 0,
      incomplete: 0,
    },
    {
      routeClass: 'record-tasks',
      count: 1,
      responseBytesTotal: null,
      responseBytesMax: null,
      clientMsTotal: 2,
      clientMsMax: 2,
      serverMsTotal: 1,
      serverMsMax: 1,
      open: 0,
      incomplete: 1,
    },
  ])
})

test('traced record fetch captures the request and response measurements', async () => {
  const calls: RecordCallTrace[] = []
  const response = await tracedRecordFetch(
    'https://record.test/v1/docs/one',
    { method: 'POST', body: '{"value":1}' },
    (async () =>
      new Response('body', {
        status: 201,
        headers: { 'content-length': '4', 'server-timing': 'app;dur=2.5' },
      })) as unknown as typeof fetch,
    (call) => calls.push(call),
  )

  expect(response.status).toBe(201)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    routeClass: 'record-docs',
    method: 'POST',
    status: 201,
    requestBytes: 11,
    responseBytes: 4,
    serverMs: 2.5,
    finish: 'complete',
  })
  expect(calls[0]!.clientMs).toBeGreaterThanOrEqual(0)
  expect(calls[0]!.open).toBeFalse()
})

test('traced record fetch counts a response body when content-length is absent', async () => {
  const calls: RecordCallTrace[] = []
  const response = await tracedRecordFetch(
    'https://record.test/v1/tasks',
    {},
    (async () => new Response('chunked body')) as unknown as typeof fetch,
    (call) => calls.push(call),
  )

  expect(await response.text()).toBe('chunked body')
  for (let attempt = 0; calls.length === 0 && attempt < 10; attempt++) await Bun.sleep(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    routeClass: 'record-tasks',
    responseBytes: 12,
    finish: 'complete',
  })
})

test('route classes derive from the first v1 path segment', () => {
  expect(recordRouteClass('/v1/questions/one')).toBe('record-questions')
  expect(recordRouteClass('/v1/moderation')).toBe('record-moderation')
  expect(recordRouteClass('/v1/board/stream')).toBe('record-board-stream')
})

test('traced fetch counts an unbounded body only as the caller reads it and records cancellation', async () => {
  const calls: RecordCallTrace[] = []
  let pulls = 0
  const response = await tracedRecordFetch(
    'https://record.test/v1/board/stream',
    {},
    (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            controller.enqueue(new Uint8Array([1, 2, 3]))
          },
        }),
      )) as unknown as typeof fetch,
    (call) => calls.push(call),
  )
  const reader = response.body!.getReader()
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]))
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]))
  await reader.cancel('test complete')

  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ responseBytes: 6, open: false, finish: 'cancelled' })
  expect(pulls).toBeLessThanOrEqual(5)
})

test.serial('trace off returns the original response and records or writes nothing', async () => {
  const previous = process.env.BOTTEGA_RECORD_TRACE
  delete process.env.BOTTEGA_RECORD_TRACE
  const originalWrite = process.stderr.write
  const writes: string[] = []
  process.stderr.write = ((value: string | Uint8Array) => {
    writes.push(String(value))
    return true
  }) as typeof process.stderr.write
  try {
    const original = new Response('body')
    const response = await tracedRecordFetch(
      'https://record.test/v1/tasks',
      {},
      (async () => original) as unknown as typeof fetch,
    )
    expect(response).toBe(original)
    expect(writes).toEqual([])
  } finally {
    process.stderr.write = originalWrite
    if (previous === undefined) delete process.env.BOTTEGA_RECORD_TRACE
    else process.env.BOTTEGA_RECORD_TRACE = previous
  }
})
