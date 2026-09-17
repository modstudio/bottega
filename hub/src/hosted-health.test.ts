import { expect, test } from 'bun:test'
import { hostedHealthResponse } from './hosted-health.ts'

test('hosted health serves the SPA only for an explicit HTML accept header', async () => {
  expect(hostedHealthResponse(new Request('https://hub.example.test/health'))).not.toBeNull()
  expect(
    hostedHealthResponse(
      new Request('https://hub.example.test/health', { headers: { accept: '*/*' } }),
    ),
  ).not.toBeNull()
  expect(
    hostedHealthResponse(
      new Request('https://hub.example.test/health', {
        headers: { accept: 'text/html,application/xhtml+xml' },
      }),
    ),
  ).toBeNull()
  expect(
    await hostedHealthResponse(
      new Request('https://hub.example.test/health', { headers: { accept: '*/*' } }),
    )?.json(),
  ).toEqual({ ok: true })
})
