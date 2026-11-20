import { expect, test } from 'bun:test'
import {
  formatRecordCallSummary,
  parseServerTiming,
  type RecordCallTrace,
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
    },
    {
      routeClass: 'record-docs',
      method: 'GET',
      status: 404,
      requestBytes: 0,
      responseBytes: 30,
      clientMs: 5,
      serverMs: null,
    },
    {
      routeClass: 'record-tasks',
      method: 'POST',
      status: 200,
      requestBytes: 10,
      responseBytes: null,
      clientMs: 2,
      serverMs: 1,
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
    },
  ])
  expect(formatRecordCallSummary(calls).at(-1)).toBe(
    'record-trace route=total count=3 response_bytes_total=150 response_bytes_max=120 client_ms_total=15.3 client_ms_max=8.3 server_ms_total=4.5 server_ms_max=3.5',
  )
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
  })
  expect(calls[0]!.clientMs).toBeGreaterThanOrEqual(0)
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
  expect(calls[0]).toMatchObject({ routeClass: 'record-tasks', responseBytes: 12 })
})
