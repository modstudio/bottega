import { expect, test } from 'bun:test'
import { hostedVersionResponse } from './hosted-version.ts'

const request = (accept = '*/*') =>
  new Request('https://hub.example.test/version', { headers: { accept } })

test('reports the hosted commit even when the client accepts HTML', async () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  const response = hostedVersionResponse(request('text/html,application/xhtml+xml'), commit)
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ commit })
})

test('reports an unknown commit', async () => {
  const response = hostedVersionResponse(request(), undefined)
  expect(response?.status).toBe(503)
  expect(await response?.json()).toEqual({
    commit: null,
    error: 'the commit this app was built from is unknown',
  })
})

test('ignores other paths', () => {
  const request = new Request('https://hub.example.test/health')
  expect(hostedVersionResponse(request, undefined)).toBeNull()
})
