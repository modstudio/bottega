import { expect, test } from 'bun:test'
import { timedRecordApiResponse } from './record-api-server.ts'

test('record API timing wrapper adds Server-Timing to success and error responses', async () => {
  const readings = [10, 12.25, 20, 24.5]
  const now = () => readings.shift()!
  const success = await timedRecordApiResponse(
    { fetch: () => Response.json({ ok: true }) },
    new Request('https://record.test/health'),
    now,
  )
  const error = await timedRecordApiResponse(
    { fetch: () => Response.json({ error: 'fixture refusal' }, { status: 403 }) },
    new Request('https://record.test/v1/docs'),
    now,
  )

  expect(success.response.status).toBe(200)
  expect(success.response.headers.get('server-timing')).toBe('app;dur=2.3')
  expect(error.response.status).toBe(403)
  expect(error.response.headers.get('server-timing')).toBe('app;dur=4.5')
})

test('record API timing wrapper counts response bytes as the body is consumed', async () => {
  const observed: Array<{ bytes: number; finish: string }> = []
  const timed = await timedRecordApiResponse(
    { fetch: () => new Response('abc') },
    new Request('https://record.test/v1/tasks'),
    () => 1,
    (bytes, _status, _durationMs, finish) => observed.push({ bytes, finish }),
  )

  expect(observed).toEqual([])
  expect(await timed.response.text()).toBe('abc')
  expect(observed).toEqual([{ bytes: 3, finish: 'complete' }])
})

test('record API timing wrapper preserves a response with immutable headers', async () => {
  const passThrough = new Response('pass-through')
  Object.defineProperty(passThrough.headers, 'set', {
    value: () => {
      throw new TypeError('immutable')
    },
  })
  const timed = await timedRecordApiResponse(
    { fetch: () => passThrough },
    new Request('https://record.test/source'),
    () => 1,
  )

  expect(timed.response).toBe(passThrough)
  expect(timed.response.status).toBe(200)
  expect(timed.response.headers.get('server-timing')).toBeNull()
})
