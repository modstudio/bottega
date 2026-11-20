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
